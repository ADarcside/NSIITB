/**
 * Namma Space multiplayer: voice chat. Audio goes browser to browser over WebRTC (a full mesh:
 * with up to 6 people each browser sends 5 small Opus streams). The relay only passes the setup
 * messages. Mic on by default, everyone hears everyone; mute keeps the call but sends silence.
 * The player who just joined starts the call with everyone already in the room.
 */

export interface VoiceOptions {
  /** Sends setup data to one player through the relay */
  signal: (to: string, data: unknown) => void;
  /** Speaking on/off for a player id, or 'me' */
  onSpeaking: (id: string, on: boolean) => void;
  /** Optional TURN/STUN servers (defaults: public STUN) */
  iceServers?: RTCIceServer[];
}

type Signal = { k: 'offer' | 'answer'; sdp: string } | { k: 'ice'; c: RTCIceCandidateInit };

interface Link {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  pending: RTCIceCandidateInit[];
  analyser: AnalyserNode | null;
  speaking: boolean;
  quietSince: number;
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];
const SPEAK_LEVEL = 0.03;
const SPEAK_HOLD_MS = 350;

export type MicState = 'off' | 'on' | 'muted' | 'denied' | 'unsupported';

export class VoiceChat {
  private readonly _opts: VoiceOptions;
  private readonly _links = new Map<string, Link>();
  private _stream: MediaStream | null = null;
  private _ctx: AudioContext | null = null;
  private _myAnalyser: AnalyserNode | null = null;
  private _mySpeaking = false;
  private _myQuietSince = 0;
  private _muted = false;
  private _state: MicState = 'off';
  private _buf = new Float32Array(512);

  constructor(opts: VoiceOptions) {
    this._opts = opts;
  }

  get micState(): MicState {
    return this._state;
  }

  get supported(): boolean {
    return typeof RTCPeerConnection !== 'undefined';
  }

  /** Call from a click (browsers need a user gesture for the mic and for playing audio) */
  async start(): Promise<MicState> {
    if (!this.supported) return (this._state = 'unsupported');
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this._ctx = new Ctx();
      void this._ctx.resume();
    } catch {
      this._ctx = null;
    }
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      this._state = this._muted ? 'muted' : 'on';
      this._applyMute();
      if (this._ctx) this._myAnalyser = this._analyse(this._stream);
      // Calls started before the mic was ready: send it to them now
      for (const link of this._links.values()) this._attachMic(link.pc);
    } catch {
      this._state = 'denied';
    }
    return this._state;
  }

  setMuted(muted: boolean): MicState {
    this._muted = muted;
    if (this._state === 'on' || this._state === 'muted') this._state = muted ? 'muted' : 'on';
    this._applyMute();
    return this._state;
  }

  get muted(): boolean {
    return this._muted;
  }

  private _applyMute(): void {
    for (const t of this._stream?.getAudioTracks() ?? []) t.enabled = !this._muted;
  }

  /** Start a call to a player (I am the newcomer) */
  call(id: string): void {
    if (!this.supported || this._links.has(id)) return;
    const link = this._link(id);
    void (async () => {
      try {
        const offer = await link.pc.createOffer();
        await link.pc.setLocalDescription(offer);
        this._opts.signal(id, { k: 'offer', sdp: offer.sdp ?? '' } satisfies Signal);
      } catch (err) {
        console.warn('[Voice] offer failed', err);
      }
    })();
  }

  hangUp(id: string): void {
    const link = this._links.get(id);
    if (!link) return;
    link.pc.close();
    link.audio.srcObject = null;
    link.audio.remove();
    this._links.delete(id);
    this._opts.onSpeaking(id, false);
  }

  async handleSignal(from: string, data: unknown): Promise<void> {
    if (!this.supported || !data || typeof data !== 'object') return;
    const s = data as Signal;
    try {
      if (s.k === 'offer') {
        // A newcomer is calling me; replace any stale link
        if (this._links.has(from)) this.hangUp(from);
        const link = this._link(from, false);
        await link.pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
        this._attachMic(link.pc);
        const answer = await link.pc.createAnswer();
        await link.pc.setLocalDescription(answer);
        this._opts.signal(from, { k: 'answer', sdp: answer.sdp ?? '' } satisfies Signal);
        this._flush(link);
      } else if (s.k === 'answer') {
        const link = this._links.get(from);
        if (!link || link.pc.signalingState !== 'have-local-offer') return;
        await link.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
        this._flush(link);
      } else if (s.k === 'ice') {
        const link = this._links.get(from);
        if (!link) return;
        if (link.pc.remoteDescription) await link.pc.addIceCandidate(s.c);
        else link.pending.push(s.c);
      }
    } catch (err) {
      console.warn('[Voice] signal failed', err);
    }
  }

  private _flush(link: Link): void {
    for (const c of link.pending.splice(0)) void link.pc.addIceCandidate(c).catch(() => {});
  }

  private _link(id: string, initiator = true): Link {
    const pc = new RTCPeerConnection({ iceServers: this._opts.iceServers ?? DEFAULT_ICE });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.style.display = 'none';
    document.body.appendChild(audio);
    const link: Link = { pc, audio, pending: [], analyser: null, speaking: false, quietSince: 0 };
    this._links.set(id, link);
    if (initiator) {
      // One audio line both ways; send the mic if we have it, else just listen
      const track = this._stream?.getAudioTracks()[0];
      if (track) pc.addTransceiver(track, { direction: 'sendrecv', streams: [this._stream!] });
      else pc.addTransceiver('audio', { direction: 'sendrecv' });
    }
    pc.onicecandidate = ev => {
      if (ev.candidate) this._opts.signal(id, { k: 'ice', c: ev.candidate.toJSON() } satisfies Signal);
    };
    pc.ontrack = ev => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      audio.srcObject = stream;
      void audio.play().catch(() => {});
      if (this._ctx) link.analyser = this._analyse(stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') console.warn('[Voice] could not connect to', id, '(network may block direct calls)');
    };
    return link;
  }

  /** Puts my mic on a call's audio line (answerer side, or mic granted late) */
  private _attachMic(pc: RTCPeerConnection): void {
    const track = this._stream?.getAudioTracks()[0];
    if (!track) return;
    const tr = pc.getTransceivers().find(t => t.receiver.track.kind === 'audio');
    if (!tr) return;
    if (tr.sender.track !== track) void tr.sender.replaceTrack(track);
    if (tr.direction !== 'sendrecv') tr.direction = 'sendrecv';
  }

  private _analyse(stream: MediaStream): AnalyserNode | null {
    if (!this._ctx) return null;
    try {
      const src = this._ctx.createMediaStreamSource(stream);
      const an = this._ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an); // not connected to the speakers: the <audio> element plays it
      return an;
    } catch {
      return null;
    }
  }

  private _level(an: AnalyserNode): number {
    an.getFloatTimeDomainData(this._buf);
    let sum = 0;
    for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i];
    return Math.sqrt(sum / this._buf.length);
  }

  /** Updates speaking rings; call a few times a second */
  tick(nowMs = performance.now()): void {
    if (this._myAnalyser) {
      const on = !this._muted && this._level(this._myAnalyser) > SPEAK_LEVEL;
      const next = on ? true : this._mySpeaking && nowMs - this._myQuietSince < SPEAK_HOLD_MS;
      if (on) this._myQuietSince = nowMs;
      if (next !== this._mySpeaking) {
        this._mySpeaking = next;
        this._opts.onSpeaking('me', next);
      }
    }
    for (const [id, link] of this._links) {
      if (!link.analyser) continue;
      const on = this._level(link.analyser) > SPEAK_LEVEL;
      if (on) link.quietSince = nowMs;
      const next = on || (link.speaking && nowMs - link.quietSince < SPEAK_HOLD_MS);
      if (next !== link.speaking) {
        link.speaking = next;
        this._opts.onSpeaking(id, next);
      }
    }
  }

  stop(): void {
    for (const id of [...this._links.keys()]) this.hangUp(id);
    for (const t of this._stream?.getTracks() ?? []) t.stop();
    this._stream = null;
    void this._ctx?.close();
    this._ctx = null;
    this._state = 'off';
  }
}
