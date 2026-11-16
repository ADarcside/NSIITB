/**
 * Namma Space AR: entry for ar.html (AR build spec). Reads the link, loads the small scene files
 * (manifest and places; never the 3D room model), and wires the state machine, the overlay and
 * the WebXR session together.
 *
 * Phase 1: support check, Start AR, floor ring, Exit.
 * Phase 2: two taps on the floor marks (tape crosses), distance and height checks, preview pins,
 * Flip, Redo, and WebXR anchors to keep the alignment locked.
 * Phase 3: after "Yes", a route from where the phone is to the place in the link (?to=), drawn as
 * a floating destination pin and turn arrows at the next corner, with metres left, a new route
 * when the walker leaves it, and an arrival screen.
 * Phase 4: an arrow at the screen edge when the way to go is out of view, a buzz on arrival,
 * a place picker to change the place without leaving AR, Re-align that keeps the place, and
 * "lost the room" only after a full second (voice and turn text: the shared tour guide).
 *
 * Link switches: ?scene=<id>  ?to=<place>  ?marks=ax,az,bx,bz (test marks)  ?pois=<url> (test
 * tags, no hash check)  ?debug=1 (tracking line).
 */

import { ArMachine, IN_SESSION, type ArState, type SupportResult } from './ar_state.js';
import { ArHud, type HudAction, type HudPicker, type HudView } from './ar_hud.js';
import { ArScene, type PinSpec } from './ar_scene.js';
import { ArSession, checkArSupport, type ArFrameInfo, type TrackedAnchor } from './ar_session.js';
import { FloorWatch } from './floor.js';
import { arTarget, viewerUrlFromAr } from './links.js';
import { findMarkPairs, marksFromParam, visiblePlaces, type MarkPair } from './marks.js';
import { TapSampler, arToScene, checkTaps, solveAlignment, type Alignment, type Vec3 } from './align.js';
import { RouteFollower, type GuideState } from '../nav/route_follower.js';
import { VoiceGuide, type GuideInput } from '../nav/voice_guide.js';
import { primeSpeechOnFirstGesture } from '../nav/voice_pref.js';
import { edgeArrow } from './edge_arrow.js';
import { startOffline } from './offline.js';
import { searchPois } from '../nav/search.js';
import { loadLang, phrase, saveLang, type Lang, type PhraseKey } from './phrases.js';
import { fetchAndValidateManifest, fetchAssetWithVerification, parseSceneParam } from '../loader/manifest.js';
import { validatePoiSet } from '../nav/pois.js';
import { resolvePoiRef } from '../nav/share.js';
import { NavPlanner, type Point2 } from '../nav/astar.js';
import type { NavGrid, POI } from '../contracts/types.js';

/** What the page knows about the room once the small scene files are in */
type SceneInfo =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ok'; name: string; pois: POI[]; places: POI[]; target: POI | null; planner: NavPlanner | null };

type Phrase = { key: PhraseKey; vars?: Record<string, string | number> };

/** How often the live line in the camera view is refreshed (ms) */
const DETAIL_EVERY_MS = 250;
/** How long a tap message ("hold still") stays before the live line returns (ms) */
const TAP_MESSAGE_MS = 2500;
/** Shown on the ?debug=1 line, to tell which build a phone screenshot is from */
const AR_BUILD = 'build p5-2';
/** Preview pins: places within this distance of the marks, nearest first, at most PIN_MAX */
const PIN_RADIUS_M = 12;
const PIN_MAX = 12;
/** The phone must be lost this long before the "lost the room" screen (ms); the pins hide at once */
const LOST_SCREEN_MS = 1000;
/** Places listed in the picker */
const PICKER_MAX = 8;
/** Buzz on arrival (ms on, off, on) */
const ARRIVE_BUZZ = [120, 80, 120];

const UNSUPPORTED_DETAIL: Record<Exclude<SupportResult, 'ok'>, PhraseKey> = {
  insecure: 'unsupportedInsecure',
  'no-webxr': 'unsupportedNoWebxr',
  'no-ar': 'unsupportedNoAr',
};

/** One tapped mark: the averaged tap point, and (when granted) an anchor that follows ARCore's map */
interface TapRecord {
  point: Vec3;
  anchor: TrackedAnchor | null;
  /** tap point minus anchor position, fixed on the first frame the anchor is placed (about 0 for a free anchor) */
  offset: Vec3 | null;
}

function copy(p: Vec3): Vec3 {
  return { x: p.x, y: p.y, z: p.z };
}

function bootstrap(): void {
  const host = document.getElementById('ar-hud');
  if (!host) throw new Error('#ar-hud not found');

  const params = new URLSearchParams(window.location.search);
  const sceneId = parseSceneParam() || (import.meta.env.VITE_DEFAULT_SCENE as string) || 'dev';
  const baseUrl = (import.meta.env.VITE_PUBLIC_BASE_URL as string) || '';
  const targetRef = arTarget(window.location.href);
  const backUrl = viewerUrlFromAr(window.location.href);
  const testMarks = marksFromParam(params.get('marks'));
  const devPoisUrl = params.get('pois');
  const debug = params.get('debug') === '1';
  /** ?qr=1: a printable sheet of QR codes for this room instead of the AR guide */
  const qrMode = params.get('qr') === '1';

  let lang: Lang = loadLang();
  let support: SupportResult = 'ok';
  let scene: SceneInfo = { status: 'loading' };
  /** Why Start AR failed, kept as a phrase so it follows the language switch */
  let startError: Phrase | null = null;
  let closedNote = false;
  let busy = false;
  let view: ArScene | null = null;
  let session: ArSession | null = null;
  const floor = new FloorWatch();
  const sampler = new TapSampler();
  let lastDetailAt = -Infinity;
  let lastFrameTime = 0;
  let lastFloor: Vec3 | null = null;
  const steady: Vec3 = { x: 0, y: 0, z: 0 };

  // Alignment
  let pair: MarkPair | null = null;
  let tapA: TapRecord | null = null;
  let tapB: TapRecord | null = null;
  let flipped = false;
  const alignment: Alignment = { theta: 0, t: { x: 0, y: 0, z: 0 } };
  /** Why the last B tap was rejected, shown on the next "align A" screen */
  let alignError: Phrase | null = null;
  /** The two taps of the last distance miss, kept so "Use anyway" can still align with them */
  let missedTaps: { a: TapRecord; b: TapRecord } | null = null;
  /** session.resets when the taps were made: a later reset means unanchored taps no longer fit */
  let resetsAtTaps = 0;
  /** The phone lost its position at some point since the taps */
  let trackingDropped = false;
  let lastTracking = true;
  /** Times the phone lost its position this session (debug line) */
  let dropCount = 0;
  let tapMessage: { text: Phrase; until: number } | null = null;
  const pa: Vec3 = { x: 0, y: 0, z: 0 };
  const pb: Vec3 = { x: 0, y: 0, z: 0 };

  // Guidance (phase 3)
  let follower: RouteFollower | null = null;
  let guide: GuideState | null = null;
  const walker3: Vec3 = { x: 0, y: 0, z: 0 };
  const ahead3: Vec3 = { x: 0, y: 0, z: 0 };
  const walker: Point2 = { x: 0, z: 0 };
  const facing: Point2 = { x: 0, z: -1 };
  /** When the alignment was first lost in this stretch (ms), for the one-second wait */
  let lostSince: number | null = null;
  /** Voice guide (nav/voice_guide.ts, shared with the 3D room): speaks turns, distance and arrival in
   *  the page's language; its text replaces the metres-left line. Started on the first guided frame. */
  const voice = new VoiceGuide(lang);
  let voiceBegun = false;
  let guideInput: GuideInput | null = null;
  /** Until when the "no voice for this language" note shows (ms, frame time) */
  let noVoiceUntil = -Infinity;
  let noVoiceText = '';
  primeSpeechOnFirstGesture();
  /** The place picker (phase 4) */
  let pickerOpen = false;
  let pickerQuery = '';

  const machine = new ArMachine();
  const t = (key: PhraseKey, vars?: Record<string, string | number>) => phrase(lang, key, vars);
  const tp = (p: Phrase) => t(p.key, p.vars);
  const langLabel = () => t('langSwitch');

  const hud = new ArHud(host, {
    onStart: () => void startAr(),
    onExit: () => void exitToViewer(),
    onBack: () => window.location.assign(backUrl),
    onLang: () => {
      lang = lang === 'en' ? 'hi' : 'en';
      saveLang(lang);
      voice.setLang(lang);
      render();
    },
    onAction: id => onAction(id),
    onPickerInput: q => {
      pickerQuery = q;
      hud.setPickerResults(pickerResults(), t('pickerEmpty'));
    },
  });

  /** The places that match the picker's search, as picker buttons */
  function pickerResults(): HudAction[] {
    if (scene.status !== 'ok') return [];
    return searchPois(scene.places, pickerQuery, PICKER_MAX).map(h => ({ id: `pick:${h.poi.poi_id}`, label: h.poi.name }));
  }

  function pickerView(): HudPicker | undefined {
    if (!pickerOpen) return undefined;
    return {
      title: t('pickerTitle'),
      placeholder: t('pickerPlaceholder'),
      query: pickerQuery,
      results: pickerResults(),
      empty: t('pickerEmpty'),
      cancel: t('cancel'),
    };
  }

  /** Goes to another place from the camera view: new route from where the walker stands. */
  function pickPlace(poiId: string): void {
    if (scene.status !== 'ok') return;
    const poi = scene.places.find(p => p.poi_id === poiId);
    pickerOpen = false;
    pickerQuery = '';
    if (!poi) {
      render();
      return;
    }
    scene = { ...scene, target: poi };
    if (machine.state === 'arrived') {
      // arrived -> navigate starts guidance (onChange)
      machine.send('new-destination');
      return;
    }
    if (machine.state === 'navigate') {
      stopGuidance();
      startGuidance();
    }
    render();
  }

  /** The mark pair to align on, or the phrase that says why there is none */
  function markStatus(): { pair: MarkPair } | { problem: Phrase } {
    if (testMarks) return { pair: testMarks };
    if (scene.status === 'loading') return { problem: { key: 'checking' } };
    if (scene.status === 'failed') return { problem: { key: 'noRoomData' } };
    const found = findMarkPairs(scene.pois);
    if (found.pairs.length > 0) return { pair: found.pairs[0] };
    if (found.problems.length > 0) return { problem: { key: 'marksProblem', vars: { problem: found.problems[0] } } };
    return { problem: { key: 'noMarks' } };
  }

  /** Puts the marks and nearby place pins into the scene (shown once aligned). */
  function preparePair(): void {
    const status = markStatus();
    pair = 'pair' in status ? status.pair : null;
    if (!pair || !view) return;
    view.setMarks(pair.a, pair.b, pair.labelA, pair.labelB);
    const mx = (pair.a.x + pair.b.x) / 2;
    const mz = (pair.a.z + pair.b.z) / 2;
    const places = scene.status === 'ok' ? scene.places : [];
    const pins: PinSpec[] = places
      .map(p => ({ name: p.name, x: p.position.x, z: p.position.z, d: Math.hypot(p.position.x - mx, p.position.z - mz) }))
      .filter(p => p.d <= PIN_RADIUS_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, PIN_MAX);
    view.setPins(pins);
  }

  function resetAlignment(): void {
    tapA = null;
    tapB = null;
    flipped = false;
    sampler.reset();
    session?.clearAnchors();
    view?.clearTapDots();
    view?.setAlignment(null);
  }

  function readyView(): HudView {
    const lines: string[] = [];
    let title = t('readyTitleNone');
    if (scene.status === 'ok') {
      lines.push(t('sceneLoaded', { scene: scene.name, n: scene.places.length }));
      if (scene.target) title = t('readyTitleTo', { place: scene.target.name });
      else if (targetRef) lines.push(t('placeNotFound'));
      else lines.push(t('readyNoPlace'));
    } else if (scene.status === 'failed') {
      lines.push(t('sceneMissing'));
    }
    if (testMarks) lines.push(t('usingTestMarks'));
    if (closedNote && !startError) lines.push(t('arClosed'));
    return {
      kind: 'ready',
      kicker: 'Namma Space AR',
      title,
      lines,
      error: startError ? tp(startError) : null,
      start: busy ? t('starting') : t('startAr'),
      busy,
      safety: t('safety'),
      back: t('backToRoom'),
      lang: langLabel(),
    };
  }

  function sessionView(state: ArState): HudView {
    let message = '';
    let note = '';
    let actions: HudAction[] = [];
    if (state === 'find-floor') {
      message = t('findFloor');
    } else if (state === 'align-a') {
      const status = markStatus();
      if ('problem' in status) {
        message = tp(status.problem);
      } else {
        message = t('alignA', { mark: status.pair.labelA });
        note = alignError ? tp(alignError) : testMarks ? t('usingTestMarks') : t('alignHint');
        if (missedTaps) actions = [{ id: 'use-anyway', label: t('useAnyway') }];
      }
    } else if (state === 'align-b') {
      message = t('alignB', { mark: pair?.labelB ?? '' });
      note = t('alignHint');
    } else if (state === 'confirm') {
      message = t('confirmQ');
      note = t('confirmHint');
      actions = [
        { id: 'yes', label: t('yes') },
        { id: 'flip', label: t('flip') },
        { id: 'redo', label: t('redo') },
      ];
    } else if (state === 'tracking-lost') {
      message = t('roomLost');
      note = t('roomLostHint');
      actions = [{ id: 'redo', label: t('redo') }];
    } else if (state === 'arrived') {
      const target = scene.status === 'ok' ? scene.target : null;
      message = t('arrivedTitle', { place: target?.name ?? '' });
      note = t('arrivedHint');
      actions = [{ id: 'change-place', label: t('changePlace') }];
    } else {
      const target = scene.status === 'ok' ? scene.target : null;
      message = target ? t('navGoing', { place: target.name }) : t('aligned');
      note = target ? t('navHint') : t('phase2Note');
      actions = [{ id: 'redo', label: t('realign') }];
      if (state === 'navigate' && scene.status === 'ok' && scene.places.length > 0)
        actions.push({ id: 'change-place', label: target ? t('changePlace') : t('pickPlace') });
    }
    const picker = state === 'navigate' || state === 'arrived' ? pickerView() : undefined;
    // Speaker button while a route is followed (text stays when muted)
    const guiding = follower !== null && (state === 'navigate' || state === 'arrived' || state === 'tracking-lost');
    const extra = guiding && voice.speaker.available ? [{ id: 'voice', label: voice.voiceButtonText() }] : undefined;
    return { kind: 'session', message, detail: '', note, actions, extra, picker, exit: t('exit'), lang: langLabel() };
  }

  function render(): void {
    hud.setLangAttr(lang);
    document.documentElement.lang = lang;
    const state = machine.state;
    lastDetailAt = -Infinity;
    if (state === 'check') hud.render({ kind: 'checking', message: t('checking') });
    else if (state === 'unsupported')
      hud.render({
        kind: 'unsupported',
        title: t('unsupportedTitle'),
        detail: t(UNSUPPORTED_DETAIL[support as Exclude<SupportResult, 'ok'>] ?? 'unsupportedNoAr'),
        back: t('backToRoom'),
        lang: langLabel(),
      });
    else if (state === 'ready') hud.render(readyView());
    else hud.render(sessionView(state));
  }

  machine.onChange((state, prev) => {
    if (state === 'align-a' && prev === 'find-floor') preparePair();
    if (state === 'align-a') {
      sampler.reset();
      stopGuidance();
    }
    if (state === 'navigate' && (prev === 'confirm' || prev === 'arrived')) startGuidance();
    if (state === 'tracking-lost') voice.trackingLost(performance.now());
    if (prev === 'tracking-lost') voice.trackingBack();
    if (state === 'arrived') {
      view?.setArrows(null);
      hud.setEdgeArrow(null);
      try {
        navigator.vibrate?.(ARRIVE_BUZZ);
      } catch {
        // Some browsers block vibration; the arrival screen is enough
      }
    }
    if (state !== 'navigate' && state !== 'arrived') pickerOpen = false;
    render();
  });

  /** Starts following a route to the place in the link, when there is one and a floor map. */
  function startGuidance(): void {
    const target = scene.status === 'ok' ? scene.target : null;
    const planner = scene.status === 'ok' ? scene.planner : null;
    if (!target || !view) return;
    const goal: Point2 = { x: target.position.x, z: target.position.z };
    view.setDestination(goal);
    view.setPinsVisible(false);
    // No floor map: a straight line to the place is still better than nothing
    follower = new RouteFollower(from => (planner ? (planner.findPath(from, goal)?.points ?? null) : [{ ...from }, goal]));
    guide = null;
    guideInput = null;
    voiceBegun = false;
  }

  function stopGuidance(): void {
    follower = null;
    guide = null;
    guideInput = null;
    voice.end();
    view?.setDestination(null);
    view?.setArrows(null);
    view?.setGoalSpot(null);
    hud.setEdgeArrow(null);
    view?.setPinsVisible(true);
  }

  /** One guidance step: where the walker is in the scan, the route, arrows, pin, arrival. */
  function guideFrame(info: ArFrameInfo): void {
    if (!follower || !view || !info.camera || alignmentLost()) return;
    arToScene(alignment, info.camera, walker3);
    walker.x = walker3.x;
    walker.z = walker3.z;
    let haveFacing = false;
    if (info.cameraForward) {
      ahead3.x = info.camera.x + info.cameraForward.x;
      ahead3.y = info.camera.y;
      ahead3.z = info.camera.z + info.cameraForward.z;
      arToScene(alignment, ahead3, ahead3);
      facing.x = ahead3.x - walker3.x;
      facing.z = ahead3.z - walker3.z;
      haveFacing = Math.hypot(facing.x, facing.z) > 0.05;
    }
    guide = follower.update(info.time, walker, haveFacing ? facing : null);
    const target = scene.status === 'ok' ? scene.target : null;
    guideInput = {
      remainingM: guide.remainingM,
      next: guide.next,
      facingAway: guide.facingAway,
      noRoute: guide.noRoute,
      rerouted: guide.replanned && follower.plans > 1,
    };
    if (!voiceBegun && target) {
      voiceBegun = true;
      voice.begin(info.time, target.name, guideInput);
    } else if (machine.state === 'navigate') voice.update(info.time, guideInput);
    if (voice.noVoiceNote) {
      noVoiceText = voice.noVoiceNote;
      noVoiceUntil = info.time + 8000;
      voice.noVoiceNote = null;
    }
    if (target) {
      const d = Math.hypot(target.position.x - walker.x, target.position.z - walker.z);
      view.updateDestination(d, t('pinLabel', { place: target.name, d: Math.max(1, Math.round(guide.noRoute ? d : guide.remainingM)) }));
    }
    const pts = follower.points;
    view.setGoalSpot(pts && pts.length > 0 && !guide.noRoute ? pts[pts.length - 1] : null);
    if (machine.state === 'navigate') {
      const showArrows = Boolean(guide.next && guide.next.arrows && !guide.noRoute);
      view.setArrows(showArrows ? guide.next : null, info.time);
      // Edge arrow toward the arrows (or the place when there are none) when out of view
      let edge = null;
      if (!guide.noRoute && !pickerOpen) {
        const aim = showArrows && guide.next ? { x: guide.next.x, y: 0, z: guide.next.z } : target ? { x: target.position.x, y: 1.6, z: target.position.z } : null;
        const p = aim ? view.projectScenePoint(aim.x, aim.y, aim.z) : null;
        edge = p ? edgeArrow(p.x, p.y, p.behind) : null;
      }
      hud.setEdgeArrow(edge);
      if (guide.arrivedNow) {
        voice.arrive(info.time);
        machine.send('arrive');
      }
    }
  }

  /** Where a tapped mark is now: the anchor's position plus the tap offset, else the tap itself. */
  function currentPoint(rec: TapRecord, out: Vec3): Vec3 {
    const a = rec.anchor;
    if (a && a.valid) {
      if (!rec.offset) rec.offset = { x: rec.point.x - a.pos.x, y: rec.point.y - a.pos.y, z: rec.point.z - a.pos.z };
      out.x = a.pos.x + rec.offset.x;
      out.y = a.pos.y + rec.offset.y;
      out.z = a.pos.z + rec.offset.z;
      return out;
    }
    out.x = rec.point.x;
    out.y = rec.point.y;
    out.z = rec.point.z;
    return out;
  }

  /** Both marks are held by anchors the phone is tracking right now */
  function anchored(): boolean {
    return Boolean(tapA?.anchor?.valid && tapB?.anchor?.valid);
  }

  /**
   * True when the taps can no longer be trusted to match the room, so the pins are hidden instead
   * of being drawn metres away:
   *  - the phone is not tracking its position this frame;
   *  - an anchor that was placed is now lost;
   *  - the marks have no working anchors and the phone has dropped tracking or reset its AR space
   *    since the taps (it may have come back with a shifted map, and nothing follows that shift).
   */
  function alignmentLost(): boolean {
    if (!tapA || !tapB || !session) return false;
    if (!lastTracking) return true;
    if (anchored()) return false;
    for (const r of [tapA, tapB]) if (r.anchor && r.offset && !r.anchor.valid) return true;
    return trackingDropped || session.resets > resetsAtTaps;
  }

  /** Recomputes the alignment from the two marks (anchored when possible) and applies it. */
  function applyAlignment(): void {
    if (!pair || !tapA || !tapB || !view) return;
    if (alignmentLost()) {
      view.setAlignment(null);
      return;
    }
    currentPoint(tapA, pa);
    currentPoint(tapB, pb);
    if (flipped) solveAlignment(pair.a, pair.b, pb, pa, alignment);
    else solveAlignment(pair.a, pair.b, pa, pb, alignment);
    view.setAlignment(alignment);
  }

  function recordTap(point: Vec3): TapRecord {
    const rec: TapRecord = { point: copy(point), anchor: null, offset: null };
    view?.addTapDot(point);
    attachAnchor(rec, true);
    return rec;
  }

  /**
   * Pins a tap to ARCore's map so the alignment follows its corrections instead of sliding.
   * A live tap (`onRing`: the ring is still on the cross) gets an anchor on the floor plane under
   * the ring, the usual and steadiest kind; the tap offset covers the small gap to the averaged
   * point. Otherwise, or if that fails, a free anchor at the exact tap point.
   */
  function attachAnchor(rec: TapRecord, onRing: boolean): void {
    const s = session;
    if (!s) return;
    void (async () => {
      let anchor = onRing ? await s.anchorAtRing() : null;
      anchor ??= await s.anchorAt(rec.point);
      // Still the same tap (no Redo meanwhile)?
      if (anchor && (tapA === rec || tapB === rec || missedTaps?.a === rec || missedTaps?.b === rec)) {
        rec.anchor = anchor;
        lastDetailAt = -Infinity;
      }
    })();
  }

  const onSelect = (): void => {
    const state = machine.state;
    if (state !== 'align-a' && state !== 'align-b') return;
    if (!pair) return;
    const point = sampler.steadyPoint(lastFrameTime, steady);
    if (!point) {
      tapMessage = { text: { key: lastFloor ? 'holdStill' : 'noFloorUnderRing' }, until: lastFrameTime + TAP_MESSAGE_MS };
      lastDetailAt = -Infinity;
      return;
    }
    tapMessage = null;
    if (state === 'align-a') {
      alignError = null;
      missedTaps = null;
      // From this first tap on, a tracking drop or AR-space reset counts against the alignment
      resetsAtTaps = session?.resets ?? 0;
      trackingDropped = false;
      session?.clearAnchors();
      view?.clearTapDots();
      tapB = null;
      tapA = recordTap(point);
      machine.send('tap-a');
      return;
    }
    if (!tapA) return;
    const check = checkTaps(pair.a, pair.b, tapA.point, point);
    if (!check.ok) {
      alignError =
        check.reason === 'distance'
          ? {
              key: 'badDistance',
              vars: { got: check.tappedM.toFixed(2), want: check.expectedM.toFixed(2), mark: pair.labelA },
            }
          : { key: 'badHeight', vars: { cm: Math.round(check.heightDiffM * 100), mark: pair.labelA } };
      if (check.reason === 'distance') {
        // Keep both taps, with their anchors and dots, in case the person picks "Use anyway"
        missedTaps = { a: tapA, b: recordTap(point) };
        tapA = null;
        tapB = null;
        flipped = false;
        sampler.reset();
        view?.setAlignment(null);
      } else {
        missedTaps = null;
        resetAlignment();
      }
      machine.send('tap-b-bad');
      return;
    }
    tapB = recordTap(point);
    flipped = false;
    applyAlignment();
    machine.send('tap-b-ok');
  };

  function onAction(id: string): void {
    const state = machine.state;
    if (id === 'yes' && state === 'confirm') {
      machine.send('confirm-yes');
    } else if (id === 'flip' && state === 'confirm') {
      flipped = !flipped;
      applyAlignment();
    } else if (id === 'use-anyway' && state === 'align-a' && missedTaps) {
      // Taps from before a tracking drop or a reset of the AR space no longer fit the room
      if (trackingDropped || (session?.resets ?? 0) > resetsAtTaps) {
        missedTaps = null;
        alignError = { key: 'roomLost' };
        session?.clearAnchors();
        view?.clearTapDots();
        render();
        return;
      }
      // The two taps come back with the anchors they got when they were made
      tapA = missedTaps.a;
      tapB = missedTaps.b;
      missedTaps = null;
      alignError = null;
      flipped = false;
      applyAlignment();
      machine.send('use-anyway');
    } else if (id === 'voice') {
      voice.toggleVoice();
      render();
    } else if (id === 'change-place' && (state === 'navigate' || state === 'arrived')) {
      pickerOpen = true;
      pickerQuery = '';
      render();
    } else if (id === 'picker-cancel') {
      pickerOpen = false;
      render();
    } else if (id.startsWith('pick:')) {
      pickPlace(id.slice(5));
    } else if (id === 'redo' && (state === 'confirm' || state === 'navigate' || state === 'tracking-lost')) {
      alignError = null;
      missedTaps = null;
      resetAlignment();
      machine.send(state === 'confirm' ? 'redo' : 'realign');
    }
  }

  function liveLine(info: ArFrameInfo): string {
    const state = machine.state;
    const parts: string[] = [];
    if (tapMessage && info.time < tapMessage.until) parts.push(tp(tapMessage.text));
    else if (state === 'confirm' && alignmentLost()) parts.push(t('roomLost'));
    else if (state === 'align-b' && pair && tapA && info.floorPoint) {
      const d = Math.hypot(info.floorPoint.x - tapA.point.x, info.floorPoint.z - tapA.point.z);
      parts.push(t('liveDistance', { d: d.toFixed(2), mark: pair.labelA, e: pair.distanceM.toFixed(2) }));
    } else if (state === 'navigate') {
      if (follower && guideInput) {
        // The voice guide's words: next turn (or Turn around), then the length left
        const line = voice.line(guideInput, info.time);
        if (line.instruction) parts.push(line.instruction);
        if (line.left) parts.push(line.left);
      }
      if (info.time < noVoiceUntil) parts.push(noVoiceText);
      if (!anchored()) parts.push(t('anchorsOff'));
      else if (!follower) parts.push(t('anchorsOn'));
    }
    if (debug) {
      const h = info.heightAboveFloorM;
      const tilt = info.firstTiltDeg === null ? '-' : `${Math.round(info.firstTiltDeg)}°`;
      parts.push(`track ${info.tracking ? 'yes' : 'no'} · hits ${info.hitCount} · tilt ${tilt}${h !== null ? ` · h ${h.toFixed(2)} m` : ''}`);
      // Each mark's anchor: none (not made), wait (made, not placed yet), lost, or how far ARCore
      // has moved it since the tap (cm), which is the drift the anchor corrects
      const anchorState = (r: TapRecord | null): string => {
        if (!r?.anchor) return 'none';
        if (!r.anchor.valid) return r.offset ? 'lost' : 'wait';
        if (!r.offset) return 'ok';
        const dx = r.anchor.pos.x + r.offset.x - r.point.x;
        const dz = r.anchor.pos.z + r.offset.z - r.point.z;
        return `${Math.round(Math.hypot(dx, dz) * 100)} cm`;
      };
      if (tapA || tapB)
        parts.push(`anchor A ${anchorState(tapA)} · B ${anchorState(tapB)} · drops ${dropCount} · resets ${session?.resets ?? 0}`);
      if (follower) {
        const nx = guide?.next;
        parts.push(
          `walker ${walker.x.toFixed(2)}, ${walker.z.toFixed(2)} · routes ${follower.plans}` +
            (nx ? ` · next ${nx.turn} in ${nx.distM.toFixed(1)} m` : '')
        );
      }
      parts.push(AR_BUILD);
    }
    return parts.join('\n');
  }

  const onFrame = (info: ArFrameInfo): void => {
    const state = machine.state;
    lastFrameTime = info.time;
    lastFloor = info.floorPoint;
    if (!info.tracking && lastTracking) {
      dropCount++;
      trackingDropped = true;
    }
    lastTracking = info.tracking;
    if (state === 'find-floor') {
      // White ring on any surface while searching, so aiming shows something; only floor counts
      view?.setRing(info.floorMatrix ?? info.anyMatrix, false);
      if (floor.update(info.time, info.floorMatrix !== null)) machine.send('floor-steady');
    } else if (state === 'align-a' || state === 'align-b') {
      sampler.push(info.time, info.floorPoint);
      // Gold once the ring has been still long enough for a tap to count
      view?.setRing(info.floorMatrix, sampler.steadyPoint(info.time, steady) !== null);
    } else if (IN_SESSION.has(state)) {
      view?.setRing(null, false);
      // Anchors follow ARCore's improving map, so the alignment is refreshed every frame
      applyAlignment();
      if (state === 'navigate' || state === 'arrived') guideFrame(info);
      const lost = alignmentLost();
      if (lost) {
        hud.setEdgeArrow(null);
        lostSince ??= info.time;
        // Pins are hidden at once; the "lost the room" screen waits a second so a blink does not flash it
        if (state === 'navigate' && info.time - lostSince >= LOST_SCREEN_MS) machine.send('tracking-lost');
      } else {
        lostSince = null;
        if (state === 'tracking-lost') machine.send('tracking-back');
      }
    }
    if (info.time - lastDetailAt >= DETAIL_EVERY_MS) {
      lastDetailAt = info.time;
      hud.setDetail(liveLine(info));
    }
  };

  const onEnd = (): void => {
    stopGuidance();
    pickerOpen = false;
    lostSince = null;
    lastTracking = true;
    trackingDropped = false;
    dropCount = 0;
    floor.reset();
    resetAlignment();
    missedTaps = null;
    view?.setRing(null, false);
    if (IN_SESSION.has(machine.state)) {
      closedNote = true;
      startError = null;
    }
    if (!machine.send('session-ended')) render();
  };

  async function startAr(): Promise<void> {
    if (busy || machine.state !== 'ready') return;
    view ??= new ArScene();
    session ??= new ArSession(view, { onFrame, onEnd, onSelect });
    busy = true;
    startError = null;
    closedNote = false;
    alignError = null;
    // No render before start(): the session request must run inside the tap, before any await
    const pending = session.start(hud.root);
    render();
    try {
      await pending;
      busy = false;
      floor.reset();
      machine.send('session-started');
    } catch (err) {
      busy = false;
      const name = err instanceof DOMException ? err.name : '';
      const msg = err instanceof Error ? err.message : String(err);
      startError =
        name === 'NotAllowedError' ? { key: 'cameraDenied' } : { key: 'startFailed', vars: { reason: msg || name || 'unknown' } };
      console.warn('[AR] Session failed to start:', err);
      render();
    }
  }

  async function exitToViewer(): Promise<void> {
    if (session?.running) await session.end();
    window.location.assign(backUrl);
  }

  /** The walkable floor map from the manifest, or null (the route then is a straight line) */
  async function loadPlanner(): Promise<NavPlanner | null> {
    try {
      const manifest = await fetchAndValidateManifest(sceneId, baseUrl);
      const gridId = manifest.assets.grid;
      if (!gridId || !manifest.asset_table[gridId]) return null;
      const buf = await fetchAssetWithVerification(manifest.asset_table[gridId]);
      return new NavPlanner(JSON.parse(new TextDecoder().decode(buf)) as NavGrid);
    } catch (err) {
      console.warn('[AR] Floor map could not be loaded, routes will be straight lines:', err);
      return null;
    }
  }

  async function loadPoiSet(): Promise<POI[]> {
    let data: unknown;
    if (devPoisUrl) {
      // Test switch, like the viewer's ?pois=: tags straight from a URL, no hash check
      const res = await fetch(devPoisUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${devPoisUrl}`);
      data = (await res.json()) as unknown;
    } else {
      const manifest = await fetchAndValidateManifest(sceneId, baseUrl);
      const poisId = manifest.assets.pois;
      if (!poisId || !manifest.asset_table[poisId]) return [];
      const buf = await fetchAssetWithVerification(manifest.asset_table[poisId]);
      data = JSON.parse(new TextDecoder().decode(buf)) as unknown;
    }
    const errs = validatePoiSet(data);
    if (errs.length > 0) throw new Error(`Invalid pois.json: ${errs.join('; ')}`);
    return (data as { pois: POI[] }).pois;
  }

  // Scene files and the support check run side by side; neither blocks the other
  const roomLoaded = (async () => {
    try {
      const [pois, planner] = await Promise.all([loadPoiSet(), loadPlanner()]);
      const places = visiblePlaces(pois);
      scene = { status: 'ok', name: sceneId, pois, places, target: resolvePoiRef(places, targetRef), planner };
    } catch (err) {
      console.warn('[AR] Room data could not be loaded:', err);
      scene = { status: 'failed' };
    }
    if (qrMode) {
      const { showQrSheet } = await import('./qr_sheet.js');
      showQrSheet(host, lang, sceneId, scene.status === 'ok' ? scene.places : null);
      return;
    }
    if (machine.state === 'ready') render();
    // Data arrived while already aligning: set up the marks now
    if (machine.state === 'align-a' && !pair) {
      preparePair();
      render();
    }
  })();

  if (qrMode) return;
  startOffline(roomLoaded);
  render();
  void checkArSupport().then(result => {
    support = result;
    machine.send(result === 'ok' ? 'supported' : 'unsupported');
  });
}

bootstrap();
