# VirtualizedList renders a window from a scroll offset that `maintainVisibleContentPosition` is about to correct

When something above the visible rows of a `FlatList` with
`maintainVisibleContentPosition` (mVCP) changes size, native mVCP moves the
scroll offset to keep the rows still. But VirtualizedList hears about the new
row positions (`onLayout`) before it hears about the new offset (`onScroll`).
If it recomputes its render window in between, it computes it for a viewport
that is too far up by the size of the change. When the change is big, that
window no longer contains the row the user is reading. The row is unmounted,
mVCP loses its anchor, and the list jumps.

**[`evidence/ios-demo.mp4`](evidence/ios-demo.mp4)**: 10 runs on the stock
list, then 10 with the fix (74 s, still frames trimmed).

- **Upstream issue:** _not filed yet_
- **Found in:** the Bluesky app, which restores a feed position and then
  prepends up to 100 newer posts above the reader

## Environment

| | |
| --- | --- |
| react-native | 0.87.1 (the code is unchanged on `main` at df5aa64) |
| react | 19.2.3 |
| Architecture | New (Fabric), Hermes |
| Reproduced on | iOS Simulator, iPhone 17 Pro, iOS 26.5 |
| Not tested | Android |
| Dependencies | Only the template's, plus `patch-package` (see below) |

## Running it

```bash
cd ReproducerApp
yarn install            # postinstall applies patches/ with patch-package
(cd ios && bundle install && bundle exec pod install)
yarn start
yarn ios
```

Tap **Run**. It builds a fresh list of 400 rows (60-200pt), scrolls it to
y=2500 like a restored feed position, notes the row at the top (`r20` at
-180pt), and prepends 100 tall rows (250-500pt) above it. Once the list is
still, the readout says where `r20` ended up: `HELD` if it is where it was,
`JUMPED` if not. **Repeat** does 10 runs and counts the jumps.

The bug is a race, so not every run jumps. Rows render 60 small views each, so
that mounting a row takes about as long as mounting a real feed post; that is
what widens the race. On an iPhone 17 Pro simulator:

| 100 rows prepended | Stock | Fix on |
| --- | --- | --- |
| Runs that jumped | **26/40** (6, 7, 8 and 5 per batch of 10) | 0/40 |
| Where the reader ends up | thousands of points away, sometimes on a blank screen | where they were |

With 60 rows prepended it's rarer: 1/10 stock, 0/10 fixed.

The readout names the row that was at the top before the prepend, and where
it is now. Prepended rows are yellow. All heights are deterministic, from a
hash of the row id, so every run lays out the same.

There's also a test that needs no device:

```bash
yarn test
```

[`__tests__/anchorCorrection.test.tsx`](ReproducerApp/__tests__/anchorCorrection.test.tsx)
drives a `VirtualizedList` through its private layout and scroll handlers, as
React Native's own tests do. It lays out the row at the start of the viewport
500pt further down, then runs the batching timer before sending the corrected
scroll offset. Stock moves the window from `20..25` to `0..9`, unmounting that
row. With the fix the window stays at `20..25` until the scroll event, then
moves around the row. Output: [`evidence/jest.log`](evidence/jest.log).

## What happens

From [`evidence/ios-stock-traced.log`](evidence/ios-stock-traced.log), round 2.
`r20` is index 120; `r0` is index 100 and moves with it:

```text
prepending 100 rows (37741pt) at y=2500.0, fix off, r20 at -180.0pt, window 0..46
scroll y=17659.0 (dy=15159.0)                      // mVCP corrects the prepend
  VL layout r0 [100] y=19178.0 jsOffset=17659.0    // a re-render moved r0 and r20 down 4019pt
  VL cellsUpdate 100..146 -> 87..96 offset=17659.0 // window computed from the old offset: r20 unmounted
scroll y=21678.0 (dy=4019.0) correction            // native's correction, 129ms later
...
settled: r20: -180.0pt -> not rendered. Top row now r67 at -2.0pt -> JUMPED
```

1. Fabric delivers `onLayout` for a commit as soon as it's laid out, before it
   is mounted. mVCP adjusts the offset when the commit is mounted, and that
   `onScroll` arrives afterwards.
2. `_onCellLayout` schedules a cells update. Here it's immediate: the rows
   moved below the old offset, so `_shouldRenderWithPriority` sees the
   viewport above the first rendered cell.
3. `_adjustCellsAroundViewport` uses `_scrollMetrics.offset`, which is still
   the old offset, with the new cell positions. The window it computes is for
   a viewport 4019pt too high, `87..96`, which drops `r20`.
4. That commit unmounts mVCP's anchor, so its correction is lost (on 0.87.1 it
   then teleports; `main` skips it), and the list ends up wherever the next
   anchor takes it.

Here the move came from VirtualizedList re-estimating the spacer above the
window after the prepend's rows reported their heights. Rows rendering above
the viewport at their real heights, or a header resizing, move the anchor the
same way. VirtualizedList already waits for the correction after a prepend
(`pendingScrollUpdateCount`); it doesn't for any of these.

[`ISSUE.md`](ISSUE.md) is the upstream report.

## The fix

When a cell's layout arrives, check whether it's the cell native mVCP is
anchored on: mounted, and laid out across the start of the viewport. If that
cell moved, native is about to move the offset by the same amount, so hold the
render window, as with a pending prepend, until the next scroll event:

```js
// _onCellLayout, before notifyCellLayout()
const anchorMetrics = this._getMaintainVisibleContentPositionAnchor(cellIndex);
// ...after it
if (anchorMetrics != null && newOffset !== anchorMetrics.offset) {
  this._pendingAnchorCorrection = true; // _adjustCellsAroundViewport keeps the window
}
// _onScroll
this._pendingAnchorCorrection = false;
```

It never grows the window, so it can't make one run away during a fling; it
only defers a recompute to the next scroll event. From
[`evidence/ios-fixed-traced.log`](evidence/ios-fixed-traced.log), the same
step with the fix on:

```text
  VL anchor index 120 moved 17479.0 -> 21498.0, offset 17659.0: awaiting correction
  VL cellsUpdate held 100..146 (awaiting correction)
scroll y=21678.0 (dy=4019.0) h=25106 (dh=4019) correction
  VL cellsUpdate 100..146 -> 90..146 offset=21678.0
```

## Toggling the fix

The **Fix** switch passes `awaitAnchorCorrection={true}` to the `FlatList`.
Toggling it also resets the list. That prop doesn't exist upstream. It comes
from [`patches/@react-native+virtualized-lists+0.87.1.patch`](ReproducerApp/patches/@react-native+virtualized-lists+0.87.1.patch),
which `patch-package` applies on `yarn install`.

- **Switch off:** the new check returns before reading anything, so
  VirtualizedList runs the stock code path.
- **Switch on:** the fix above. The prop exists only so that stock and fixed
  can be compared in the same app. The proposed fix has no prop.

`App.tsx` is the whole repro. FlatList's TypeScript types don't know the prop,
hence the one `@ts-expect-error`.

## Demo video

**[`evidence/ios-demo.mp4`](evidence/ios-demo.mp4)**: iPhone 17 Pro simulator,
iOS 26.5, 74 s. One take, still frames trimmed. Each run resets the list,
scrolls to y=2500 and prepends 100 rows; a run that holds ends on `r21`-`r25`
with `r20` just above.

| Time | What happens |
| --- | --- |
| 0:00 | Stock. Tap **Repeat**. |
| 0:02-0:38 | 10 runs. Several end far from `r20`, for example on `r147`-`r151` (0:14), `r79`-`r82` (0:22), `r67`-`r71` (0:26) and `r84`-`r89` (0:30), or on blank space. |
| 0:40 | The readout: `5/10 jumped`. |
| 0:42 | **Fix** on, then **Repeat**. |
| 0:44-0:70 | 10 runs, each back on `r21`-`r25`. |
| 0:72 | `0/10 jumped`. |

The video carries Argent's watermark (the tool used to record it).

## Logs

| File | What |
| --- | --- |
| [`evidence/ios-stock.log`](evidence/ios-stock.log), [`ios-fixed.log`](evidence/ios-fixed.log) | Two batches of 10 runs each, stock (7/10, 8/10 jumped) and fixed (0/10, 0/10) |
| [`evidence/ios-stock-traced.log`](evidence/ios-stock-traced.log), [`ios-fixed-traced.log`](evidence/ios-fixed-traced.log) | One batch each (6/10 and 0/10) with temporary tracing inside VirtualizedList: the `VL` lines. The tracing isn't in the patch. |
| [`evidence/ios-demo.log`](evidence/ios-demo.log) | The JS console during the demo video |
| [`evidence/ios-60-rows.log`](evidence/ios-60-rows.log) | 60 rows prepended: 1/10 stock, 0/10 fixed |
| [`evidence/jest.log`](evidence/jest.log) | `yarn test` |

## Related

- **At the very top of the list** (prepend while at y=0) this repro's list
  jumps too, with or without the fix. That one is iOS mVCP anchoring on a
  VirtualizedList spacer that ends exactly at the top edge,
  [react/react-native#58913](https://github.com/react/react-native/issues/58913).
  Run starts at y=2500 to keep it out of the way.
- [react/react-native#58909](https://github.com/react/react-native/issues/58909)
  (a prepend batched with a cells update is missed) and
  [#58870](https://github.com/react/react-native/issues/58870) (interior spacer
  oscillation) are separate VirtualizedList bugs in the same area. Their fixes
  and this one don't overlap.
