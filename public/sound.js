// sound.js — tiny WebAudio sound-effects kit (no audio files needed).
//
// Every effect is synthesised on the fly from oscillators / noise, so the app
// ships zero binary audio assets. A single AudioContext is created lazily and
// resumed on the first user gesture (browsers block audio until then). The
// on/off preference is a device setting, kept in localStorage.

const PREF_KEY = 'pokapoka:sound';

export function createSound() {
  let ctx = null;
  let master = null;
  let enabled = loadPref();

  function loadPref() {
    try { return localStorage.getItem(PREF_KEY) !== 'off'; } catch { return true; }
  }
  function savePref() {
    try { localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off'); } catch { /* ignore */ }
  }

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    return ctx;
  }

  // Resume the context (call from a user gesture once).
  function unlock() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }

  // A single tone with an envelope.
  function tone({ freq = 440, dur = 0.12, type = 'sine', gain = 0.3, slideTo = null, delay = 0 }) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  // Short filtered-noise burst (card slide / chip shuffle).
  function noise({ dur = 0.12, gain = 0.25, hp = 1200, delay = 0 }) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const frames = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = hp;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter); filter.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur);
  }

  // The named effects.
  const fx = {
    click:  () => tone({ freq: 320, dur: 0.06, type: 'triangle', gain: 0.18 }),
    deal:   () => noise({ dur: 0.09, gain: 0.22, hp: 1600 }),
    check:  () => tone({ freq: 300, dur: 0.08, type: 'sine', gain: 0.22 }),
    call:   () => { tone({ freq: 480, dur: 0.09, type: 'triangle', gain: 0.22 }); noise({ dur: 0.07, gain: 0.12, hp: 2200, delay: 0.02 }); },
    raise:  () => { tone({ freq: 420, dur: 0.1, type: 'sawtooth', gain: 0.2, slideTo: 700 }); noise({ dur: 0.08, gain: 0.14, hp: 2000, delay: 0.03 }); },
    fold:   () => tone({ freq: 260, dur: 0.14, type: 'sine', gain: 0.2, slideTo: 140 }),
    allin:  () => { tone({ freq: 440, dur: 0.16, type: 'sawtooth', gain: 0.24, slideTo: 880 }); tone({ freq: 660, dur: 0.18, type: 'square', gain: 0.14, delay: 0.06 }); },
    turn:   () => { tone({ freq: 660, dur: 0.1, type: 'sine', gain: 0.22 }); tone({ freq: 990, dur: 0.12, type: 'sine', gain: 0.16, delay: 0.09 }); },
    win:    () => { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.18, type: 'triangle', gain: 0.22, delay: i * 0.1 })); },
    // Triumphant end-of-game fanfare for the winner/results screen.
    congrats: () => {
      const melody = [523, 659, 784, 1047, 784, 1047, 1319]; // C E G C G C E(hi)
      melody.forEach((f, i) => tone({ freq: f, dur: 0.16, type: 'triangle', gain: 0.24, delay: i * 0.12 }));
      // final chord
      [784, 1047, 1319].forEach((f) => tone({ freq: f, dur: 0.5, type: 'triangle', gain: 0.18, delay: melody.length * 0.12 }));
    },
    chip:   () => noise({ dur: 0.12, gain: 0.2, hp: 2600 }),
    // Turn-clock ticks: a soft tock each second, a sharp urgent tick in the
    // final seconds.
    tick:     () => tone({ freq: 900, dur: 0.035, type: 'square', gain: 0.08 }),
    tickRush: () => { tone({ freq: 1300, dur: 0.05, type: 'square', gain: 0.2 }); tone({ freq: 1700, dur: 0.05, type: 'square', gain: 0.12, delay: 0.05 }); },
  };

  function play(name) {
    if (!enabled) return;
    unlock();
    const f = fx[name];
    if (f) { try { f(); } catch { /* ignore */ } }
  }

  // ── Voice clips (pre-recorded TTS words) ──────────────────────────────────
  // One base clip per action word lives in /voice/*.wav. Per-PLAYER uniqueness
  // comes from `rate` (playbackRate = pitch + speed shift), which the caller
  // derives deterministically from the player's avatar token — so the same
  // player always "speaks" with the same voice on every device.
  const VOICE_URLS = {
    check: './voice/check.wav',
    call: './voice/call.wav',
    raise: './voice/raise.wav',
    allin: './voice/allin.wav',
  };
  const voiceBufs = {};
  let voicesRequested = false;

  function loadVoices() {
    if (voicesRequested) return;
    voicesRequested = true;
    const c = ensure();
    if (!c) return;
    for (const [name, url] of Object.entries(VOICE_URLS)) {
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((ab) => c.decodeAudioData(ab))
        .then((buf) => { voiceBufs[name] = buf; })
        .catch(() => { /* fall back to the synth beep for this word */ });
    }
  }

  function voice(name, rate = 1) {
    if (!enabled) return;
    unlock();
    const c = ensure();
    if (!c) return;
    const buf = voiceBufs[name];
    if (!buf) { loadVoices(); play(name); return; } // not loaded yet → beep fallback
    try {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = c.createGain();
      g.gain.value = 0.9;
      src.connect(g); g.connect(master);
      src.start();
    } catch { /* ignore */ }
  }

  function setEnabled(on) {
    enabled = !!on;
    savePref();
    if (enabled) { unlock(); play('click'); }
  }

  return {
    play,
    voice,
    loadVoices,
    unlock,
    isOn: () => enabled,
    toggle: () => { setEnabled(!enabled); return enabled; },
    setEnabled,
  };
}
