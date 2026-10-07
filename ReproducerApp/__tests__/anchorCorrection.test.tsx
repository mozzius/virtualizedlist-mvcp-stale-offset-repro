/**
 * The bug without a device: VirtualizedList recomputes its render window
 * between a layout event that moved the maintainVisibleContentPosition anchor
 * and the scroll event that carries native's correction for it.
 *
 * Like React Native's own VirtualizedList tests, this drives the list through
 * its private handlers (`_onLayout`, `_onContentSizeChange`, `_onCellLayout`,
 * `_onScroll`). Those are what the native layout and scroll events call.
 *
 * @format
 */

import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { VirtualizedList } from 'react-native';

jest.useFakeTimers();

type Item = { key: string };

const ITEM_HEIGHT = 10;
const VIEWPORT = { width: 10, height: 50 };

function items(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ key: String(i) }));
}

async function run(fix: boolean) {
  const data = items(40);
  let component!: ReactTestRenderer;
  await act(() => {
    component = create(
      <VirtualizedList
        {...({
          data,
          renderItem: ({ item }: { item: Item }) =>
            React.createElement('Item', { value: item.key }),
          getItem: (d: Item[], index: number) => d[index],
          getItemCount: (d: Item[]) => d.length,
          keyExtractor: (item: Item) => item.key,
          initialNumToRender: 1,
          windowSize: 1,
          maintainVisibleContentPosition: { minIndexForVisible: 0 },
          // Added by patches/@react-native+virtualized-lists+0.87.1.patch.
          awaitAnchorCorrection: fix,
        } as any)}
      />,
    );
  });
  const list = component.root.findByType(VirtualizedList as any)
    .instance as any;
  const contentHeight = data.length * ITEM_HEIGHT;
  const scrollTo = (y: number) =>
    list._onScroll({
      timeStamp: Date.now(),
      nativeEvent: {
        contentOffset: { x: 0, y },
        contentSize: { width: 10, height: contentHeight },
        layoutMeasurement: VIEWPORT,
        zoomScale: 1,
      },
    });
  // Native lays out cell 0 (kept for scroll-to-top) and the render window,
  // `shift` further down than their index says.
  const layoutRenderedCells = (shift = 0) => {
    const { first, last } = list.state.cellsAroundViewport;
    const indices = [0];
    for (let i = Math.max(1, first); i <= last; i++) {
      indices.push(i);
    }
    for (const i of indices) {
      list._onCellLayout(
        {
          nativeEvent: {
            layout: { x: 0, y: i * ITEM_HEIGHT + shift, width: 10, height: 10 },
          },
        },
        String(i),
        i,
      );
    }
  };

  await act(() => {
    list._onLayout({ nativeEvent: { layout: VIEWPORT } });
    list._onContentSizeChange(10, contentHeight);
    layoutRenderedCells();
    scrollTo(205);
    jest.runAllTimers();
  });
  await act(() => {
    layoutRenderedCells();
    jest.runAllTimers();
  });
  const before = { ...list.state.cellsAroundViewport };

  // Content above the cells grows by 500 (e.g. a header), moving cell 20, the
  // one at the top of the viewport, down by 500. A cells update runs before
  // the scroll event with native's correction.
  await act(() => {
    layoutRenderedCells(500);
    jest.runAllTimers();
  });
  const beforeCorrection = { ...list.state.cellsAroundViewport };

  await act(() => {
    scrollTo(705);
    jest.runAllTimers();
  });
  const afterCorrection = { ...list.state.cellsAroundViewport };
  return { before, beforeCorrection, afterCorrection };
}

test('stock: the window follows the stale offset and unmounts cell 20', async () => {
  const r = await run(false);
  expect(r.before).toEqual({ first: 20, last: 25 });
  expect(r.beforeCorrection).toEqual({ first: 0, last: 9 });
});

test('fixed: the window waits for the correction and keeps cell 20', async () => {
  const r = await run(true);
  expect(r.before).toEqual({ first: 20, last: 25 });
  expect(r.beforeCorrection).toEqual({ first: 20, last: 25 });
  expect(r.afterCorrection.first).toBeLessThanOrEqual(20);
  expect(r.afterCorrection.last).toBeGreaterThanOrEqual(20);
});
