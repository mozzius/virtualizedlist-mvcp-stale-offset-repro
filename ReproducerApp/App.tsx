/**
 * Repro: with maintainVisibleContentPosition, VirtualizedList can compute its
 * render window from a scroll offset that native is about to correct, and
 * unmount the row the user is reading.
 *
 * See ../README.md.
 *
 * @format
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

type Row = { id: string; height: number };

const ROW_COUNT = 400;
const PREPEND_SIZES = [100, 60];
/** Where the reader is when the rows arrive, like a restored feed position. */
const START_OFFSET = 2500;
/** Small views per row, so mounting a row costs about what a feed post does. */
const DOTS_PER_ROW = 60;
const REPEAT_ROUNDS = 10;
const WINDOW_SIZE = 9;

function hash(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic heights, so every run lays out the same: 60-200pt for the
 * initial rows, 250-500pt for prepended ones.
 */
function makeRows(prefix: string, count: number, tall: boolean): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `${prefix}${i}`;
    const height = tall ? 250 + (hash(id) % 251) : 60 + (hash(id) % 141);
    return { id, height };
  });
}

const t0 = Date.now();
function log(message: string) {
  console.log(`[anchor] +${Date.now() - t0}ms ${message}`);
}

/**
 * Diagnostics only, not needed for the bug: VirtualizedList's render window
 * and the scroll offset it last saw.
 */
function readList(list: unknown) {
  const vl = (list as any)?._listRef;
  const s = vl?.state;
  if (!s) {
    return null;
  }
  return {
    first: s.cellsAroundViewport.first as number,
    last: s.cellsAroundViewport.last as number,
    offset: vl._scrollMetrics?.offset as number,
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type ViewRef = React.ComponentRef<typeof View>;

const rowRefs = new Map<string, ViewRef>();
/** The row at the top of the viewport when the prepend was issued. */
let anchorId: string | null = null;

function RowView({ row }: { row: Row }) {
  useEffect(() => {
    if (row.id !== anchorId) {
      return;
    }
    log(`${row.id} mounted`);
    return () => {
      if (row.id === anchorId) {
        log(`${row.id} UNMOUNTED`);
      }
    };
  }, [row.id]);
  return (
    <View
      ref={ref => {
        if (ref) {
          rowRefs.set(row.id, ref);
        } else {
          rowRefs.delete(row.id);
        }
      }}
      style={[
        styles.row,
        { height: row.height },
        row.id.startsWith('p') && styles.prepended,
      ]}
    >
      <Text style={styles.rowText}>
        {row.id} ({row.height}pt)
      </Text>
      <View style={styles.dots}>
        {Array.from({ length: DOTS_PER_ROW }, (_, i) => (
          <View key={i} style={styles.dot} />
        ))}
      </View>
    </View>
  );
}

function measureInWindow(view: ViewRef) {
  return new Promise<{ y: number; height: number }>(resolve =>
    view.measureInWindow((_x, y, _w, height) => resolve({ y, height })),
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <Repro />
    </SafeAreaProvider>
  );
}

type Result = { held: boolean; summary: string };

type Pending = {
  at: number;
  head: string;
  anchor: { id: string; y: number };
  resolve: (r: Result) => void;
};

function Repro() {
  const listRef = useRef<FlatList<Row>>(null);
  const listViewRef = useRef<ViewRef>(null);
  const [fix, setFix] = useState(false);
  const [sizeIndex, setSizeIndex] = useState(0);
  const prependCount = PREPEND_SIZES[sizeIndex];
  const [generation, setGeneration] = useState(0);
  const [rows, setRows] = useState(() => makeRows('r', ROW_COUNT, false));
  const [readout, setReadout] = useState<string[]>(['Tap Run.']);
  const [busy, setBusy] = useState(false);

  const scroll = useRef({ y: 0, h: 0, t: 0, corrections: 0 });
  const pending = useRef<Pending | null>(null);
  const watch = useRef<null | { until: number; last: string }>(null);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const h = e.nativeEvent.contentSize.height;
    const dy = y - scroll.current.y;
    const dh = h - scroll.current.h;
    // An offset change that matches a content size change is mVCP keeping the
    // anchor in place, not the user scrolling.
    const correction = Math.abs(dh) >= 20 && Math.abs(dy - dh) <= 2;
    if (correction) {
      scroll.current.corrections += 1;
    }
    scroll.current = { ...scroll.current, y, h, t: Date.now() };
    if (pending.current) {
      log(
        `scroll y=${y.toFixed(1)} (dy=${dy.toFixed(1)}) h=${h.toFixed(0)} (dh=${dh.toFixed(0)})` +
          (correction ? ' correction' : ''),
      );
    }
  };

  // Log every change of the render window for a few seconds after a prepend,
  // with the scroll offset VirtualizedList had at the time.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const w = watch.current;
      if (w && Date.now() < w.until) {
        const s = readList(listRef.current);
        const key = s ? `${s.first}..${s.last}` : '';
        if (s && key !== w.last) {
          log(`window ${w.last} -> ${key} (offset ${s.offset?.toFixed(1)})`);
          w.last = key;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Runs after VirtualizedList has committed the new data.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p || rows[0].id !== p.head) {
      return;
    }
    const s = readList(listRef.current);
    log(`commit: window ${s?.first}..${s?.last}`);
  }, [rows]);

  /** Screen positions of the mounted rows, relative to the top of the list. */
  const measureRows = async () => {
    const out = new Map<string, { y: number; height: number }>();
    const list = listViewRef.current;
    if (!list) {
      return out;
    }
    const { y: listY } = await measureInWindow(list);
    await Promise.all(
      [...rowRefs].map(async ([rowId, view]) => {
        const m = await measureInWindow(view);
        out.set(rowId, { y: m.y - listY, height: m.height });
      }),
    );
    return out;
  };
  const topOf = (measured: Map<string, { y: number; height: number }>) => {
    for (const [id, m] of measured) {
      if (m.y <= 0.5 && m.y + m.height > 0.5) {
        return { id, y: m.y };
      }
    }
    return null;
  };

  // Once the list is still, find where the row the user was reading went.
  useEffect(() => {
    const id = setInterval(async () => {
      const p = pending.current;
      if (!p) {
        return;
      }
      const now = Date.now();
      if (now - p.at < 1500 || now - scroll.current.t < 700) {
        return;
      }
      pending.current = null;
      watch.current = null;
      const measured = await measureRows();
      const top = topOf(measured);
      const y = measured.get(p.anchor.id)?.y ?? null;
      anchorId = null;
      const held = y != null && Math.abs(y - p.anchor.y) <= 2;
      const s = readList(listRef.current);
      const summary =
        `${p.anchor.id}: ${p.anchor.y.toFixed(1)}pt -> ` +
        `${y == null ? 'not rendered' : `${y.toFixed(1)}pt`}. ` +
        `Top row now ${top?.id} at ${top?.y.toFixed(1)}pt. ` +
        `${scroll.current.corrections} corrections, window ${s?.first}..${s?.last}`;
      log(`settled: ${summary} -> ${held ? 'HELD' : 'JUMPED'}`);
      p.resolve({ held, summary });
    }, 100);
    return () => clearInterval(id);
  }, []);

  const reset = (nextFix = fix) => {
    pending.current = null;
    watch.current = null;
    anchorId = null;
    scroll.current = { y: 0, h: 0, t: 0, corrections: 0 };
    rowRefs.clear();
    setFix(nextFix);
    setRows(makeRows('r', ROW_COUNT, false));
    setGeneration(g => g + 1);
    log(`reset, fix ${nextFix ? 'on' : 'off'}`);
  };

  /**
   * One round: a fresh list, scrolled to START_OFFSET, gets `prependCount`
   * tall rows prepended, and we wait for it to settle.
   */
  const runOnce = async (): Promise<Result> => {
    reset(fix);
    await sleep(1200);
    listRef.current?.scrollToOffset({ offset: START_OFFSET, animated: false });
    await sleep(1500);
    const before = topOf(await measureRows());
    if (!before) {
      return { held: false, summary: 'no row at the top' };
    }
    anchorId = before.id;
    const added = makeRows('p', prependCount, true);
    const total = added.reduce((sum, r) => sum + r.height, 0);
    const s = readList(listRef.current);
    scroll.current.corrections = 0;
    watch.current = {
      until: Date.now() + 3000,
      last: s ? `${s.first}..${s.last}` : '',
    };
    log(
      `prepending ${prependCount} rows (${total}pt) at y=${scroll.current.y.toFixed(1)}, ` +
        `fix ${fix ? 'on' : 'off'}, ${before.id} at ${before.y.toFixed(1)}pt, ` +
        `window ${s?.first}..${s?.last}`,
    );
    return new Promise<Result>(resolve => {
      pending.current = {
        at: Date.now(),
        head: added[0].id,
        anchor: before,
        resolve,
      };
      setRows(prev => [...added, ...prev]);
    });
  };

  const run = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setReadout([`Running: ${prependCount} rows, fix ${fix ? 'on' : 'off'}…`]);
    const r = await runOnce();
    setReadout([
      `Fix ${fix ? 'on' : 'off'}, ${prependCount} rows prepended above the reader`,
      r.summary,
      r.held ? 'HELD' : 'JUMPED: the row you were reading moved',
    ]);
    setBusy(false);
  };

  const repeat = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    let jumped = 0;
    for (let i = 1; i <= REPEAT_ROUNDS; i++) {
      setReadout([
        `Repeat, fix ${fix ? 'on' : 'off'}: round ${i}/${REPEAT_ROUNDS}, ${jumped} jumped so far…`,
      ]);
      const r = await runOnce();
      if (!r.held) {
        jumped += 1;
      }
      log(`round ${i}/${REPEAT_ROUNDS}: ${r.held ? 'HELD' : 'JUMPED'}`);
    }
    const line = `Repeat, fix ${fix ? 'on' : 'off'}, ${prependCount} rows: ${jumped}/${REPEAT_ROUNDS} jumped`;
    log(line);
    setReadout([line]);
    setBusy(false);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.controls}>
          <Button label="Run" onPress={run} />
          <Button label="Repeat" onPress={repeat} />
          <Button
            label={`${prependCount} rows`}
            onPress={() => setSizeIndex(i => (i + 1) % PREPEND_SIZES.length)}
          />
          <View style={styles.fix}>
            <Text style={styles.fixLabel}>Fix</Text>
            <Switch
              value={fix}
              onValueChange={value => {
                reset(value);
                setReadout(['Tap Run.']);
              }}
              accessibilityLabel="Fix"
            />
          </View>
        </View>
        <Text style={styles.readout} testID="readout">
          {readout.filter(Boolean).join('\n')}
        </Text>
      </View>
      <View ref={listViewRef} style={styles.list} collapsable={false}>
        <FlatList
          key={generation}
          ref={listRef}
          data={rows}
          keyExtractor={row => row.id}
          renderItem={({ item }) => <RowView row={item} />}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          windowSize={WINDOW_SIZE}
          onScroll={onScroll}
          scrollEventThrottle={16}
          // @ts-expect-error added by patches/@react-native+virtualized-lists+0.87.1.patch
          awaitAnchorCorrection={fix}
        />
      </View>
    </SafeAreaView>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { padding: 8, gap: 6, borderBottomWidth: 1, borderColor: '#ccc' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  button: {
    backgroundColor: '#e4e6eb',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  buttonPressed: { opacity: 0.6 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  fix: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
  },
  fixLabel: { fontSize: 15, fontWeight: '600' },
  readout: {
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    minHeight: 48,
  },
  list: { flex: 1 },
  row: {
    padding: 8,
    borderBottomWidth: 1,
    borderColor: '#ccc',
    backgroundColor: '#f6f8fa',
  },
  prepended: { backgroundColor: '#fff3d6' },
  rowText: { fontSize: 16 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#9ab' },
});
