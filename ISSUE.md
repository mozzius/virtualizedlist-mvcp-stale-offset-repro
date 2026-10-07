# VirtualizedList computes its render window from a scroll offset that `maintainVisibleContentPosition` is about to correct, and unmounts the visible row

### Description

When content above the visible rows of a `FlatList` with `maintainVisibleContentPosition` changes size, native mVCP moves the offset to keep those rows still. VirtualizedList gets the rows' new positions (`onLayout`) before it gets the corrected offset (`onScroll`). A cells update that runs in between computes the window for a viewport that is too far up by the size of the change. If the change is large, that window no longer contains the visible row, so it's unmounted, mVCP loses its anchor, and the list jumps.

In the repro, a list scrolled to y=2500 gets 100 tall rows prepended. On an iPhone 17 Pro simulator the reader's row was lost in **26 of 40** runs on stock 0.87.1 and in **0 of 40** with the fix below.

#### Cause

1. Fabric delivers a commit's layout events before the commit is mounted. mVCP corrects the offset at mount, and that scroll event arrives after.
2. [`_onCellLayout`](https://github.com/react/react-native/blob/df5aa64a7fa9a13962abf2c2cfc1b386be5dfbb5/packages/virtualized-lists/Lists/VirtualizedList.js#L1326-L1345) schedules a cells update. It's often immediate: the rows now sit below the old offset, so `_shouldRenderWithPriority` sees the viewport above the first rendered cell.
3. [`_adjustCellsAroundViewport`](https://github.com/react/react-native/blob/df5aa64a7fa9a13962abf2c2cfc1b386be5dfbb5/packages/virtualized-lists/Lists/VirtualizedList.js#L632-L638) combines the old `_scrollMetrics.offset` with the new cell metrics.

VirtualizedList already waits for the correction after a prepend (`pendingScrollUpdateCount`), but not when the anchor moves for any other reason: a spacer re-estimated after the average cell length changes, rows mounting above the viewport at their real heights, a header resizing. In the repro it's the spacer, on the render right after the prepend's correction.

#### Proposed fix

In `_onCellLayout`, if the cell mVCP is anchored on (mounted, laid out across the start of the viewport) moved, hold the window until the next scroll event, as for a pending prepend. It never grows the window, so flings are unaffected. PR to follow.

### Steps to reproduce

1. `git clone https://github.com/mozzius/virtualizedlist-mvcp-stale-offset-repro && cd virtualizedlist-mvcp-stale-offset-repro/ReproducerApp && yarn install`
2. `cd ios && bundle install && bundle exec pod install && cd ..`, then `yarn start` and `yarn ios`
3. Tap **Repeat**. It runs 10 times: a fresh list scrolled to y=2500, then 100 rows prepended. It's a race, so expect 5-8 of the 10 to jump.
4. Turn on **Fix** (the repro's patch adds the fix behind an `awaitAnchorCorrection` prop) and tap **Repeat** again: `0/10 jumped`.

`yarn test` shows the same thing without a device.

### React Native Version

0.87.1. The code is unchanged on `main` (df5aa64).

### Affected Platforms

Runtime - iOS

### Output of `npx @react-native-community/cli info`

```text
System:
  OS: macOS 27.0.1
IDEs:
  Xcode: 27.0/27A266a
npmPackages:
  react: 19.2.3
  react-native: 0.87.1
iOS:
  hermesEnabled: true
  newArchEnabled: true
```

iOS Simulator, iPhone 17 Pro, iOS 26.5. Android wasn't tested.

### Stacktrace or Logs

`VL` lines are temporary tracing inside VirtualizedList. `r20` (index 120) is the row at the top; `r0` (index 100) moves with it:

```text
scroll y=17659.0 (dy=15159.0)                      // the prepend is corrected
  VL layout r0 [100] y=19178.0 jsOffset=17659.0    // a re-render moves r0 and r20 down 4019pt
  VL cellsUpdate 100..146 -> 87..96 offset=17659.0 // window from the old offset: r20 unmounted
scroll y=21678.0 (dy=4019.0) correction            // the correction, 129ms later
settled: r20: -180.0pt -> not rendered. Top row now r67 at -2.0pt -> JUMPED
```

With the fix, the same step: `cellsUpdate held 100..146 (awaiting correction)`, then the window moves after `scroll y=21678.0`. Full logs are in the repro's [`evidence/`](https://github.com/mozzius/virtualizedlist-mvcp-stale-offset-repro/tree/main/evidence).

### MANDATORY Reproducer

https://github.com/mozzius/virtualizedlist-mvcp-stale-offset-repro

### Screenshots and Videos

[`ios-demo.mp4`](https://github.com/mozzius/virtualizedlist-mvcp-stale-offset-repro/blob/main/evidence/ios-demo.mp4): 10 stock runs (5 jump, several to blank space), then 10 with the fix (none).
