/* Tartarus Simulator: sound effects.
 * Everything is synthesized with the Web Audio API, so there are no audio
 * files to load. Browsers only allow sound after the first click or key. */
(function (root) {
  'use strict';

  let ctx = null;
  let out = null;
  let enabled = true;
  let volume = 0.6;
  let noiseBuffer = null;

  function audio() {
    if (!enabled) return null;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      try {
        ctx = new AC();
        out = ctx.createGain();
        out.gain.value = volume;
        out.connect(ctx.destination);
      } catch (e) {
        ctx = null;
        return null;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function envelope(gain, t, attack, peak, decay) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  function tone(c, o) {
    const t = c.currentTime + (o.at || 0);
    const attack = o.attack || 0.005;
    const decay = o.decay || 0.25;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + attack + decay);
    envelope(gain, t, attack, o.peak || 0.15, decay);
    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  function noise(c, o) {
    if (!noiseBuffer) {
      noiseBuffer = c.createBuffer(1, Math.floor(c.sampleRate * 0.6), c.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = c.currentTime + (o.at || 0);
    const attack = o.attack || 0.003;
    const decay = o.decay || 0.2;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = c.createBiquadFilter();
    filter.type = o.filter || 'lowpass';
    filter.frequency.value = o.freq || 1200;
    filter.Q.value = o.q || 0.7;
    const gain = c.createGain();
    envelope(gain, t, attack, o.peak || 0.2, decay);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    src.start(t);
    src.stop(t + attack + decay + 0.05);
  }

  const SOUNDS = {
    open(c) {
      noise(c, { decay: 0.16, peak: 0.3, freq: 900 });
      tone(c, { f: 92, to: 48, type: 'triangle', decay: 0.32, peak: 0.28 });
      noise(c, { at: 0.13, decay: 0.07, peak: 0.1, freq: 3200, filter: 'bandpass', q: 5 });
    },
    select(c) {
      tone(c, { f: 640, decay: 0.04, peak: 0.035, type: 'triangle' });
    },
    devour(c) {
      tone(c, { f: 170, to: 52, type: 'sawtooth', decay: 0.34, peak: 0.16 });
      noise(c, { decay: 0.24, peak: 0.24, freq: 520 });
      tone(c, { f: 523, to: 784, at: 0.18, type: 'triangle', decay: 0.2, peak: 0.08 });
    },
    promote(c) {
      tone(c, { f: 523, to: 784, type: 'triangle', decay: 0.22, peak: 0.1 });
    },
    swap(c) {
      tone(c, { f: 330, type: 'triangle', decay: 0.08, peak: 0.09 });
      tone(c, { f: 494, at: 0.07, type: 'triangle', decay: 0.1, peak: 0.09 });
      tone(c, { f: 392, at: 0.14, type: 'triangle', decay: 0.12, peak: 0.07 });
    },
    rainbow(c) {
      [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(c, { f, at: i * 0.07, type: 'triangle', decay: 0.55, peak: 0.1 }));
    },
    hatch(c) {
      [1180, 1480, 1320].forEach((f, i) => tone(c, { f, to: f * 1.25, at: i * 0.07, decay: 0.05, peak: 0.05 }));
    },
    nest(c) {
      noise(c, { decay: 0.3, peak: 0.12, freq: 2400, filter: 'bandpass', q: 2 });
    },
    collapse(c) {
      noise(c, { decay: 0.45, peak: 0.28, freq: 380 });
      tone(c, { f: 70, to: 40, type: 'triangle', decay: 0.4, peak: 0.2 });
    },
    day(c) {
      tone(c, { f: 392, decay: 1.2, peak: 0.12 });
      tone(c, { f: 784, decay: 0.8, peak: 0.04 });
      tone(c, { f: 1176, decay: 0.5, peak: 0.025 });
    },
    tool(c) {
      tone(c, { f: 880, decay: 0.12, peak: 0.06, type: 'triangle' });
      tone(c, { f: 1320, at: 0.06, decay: 0.2, peak: 0.05, type: 'triangle' });
    },
    end(c) {
      [392, 523, 659, 784].forEach((f, i) => tone(c, { f, at: i * 0.13, type: 'triangle', decay: 0.7, peak: 0.1 }));
    },
    error(c) {
      tone(c, { f: 150, type: 'square', decay: 0.11, peak: 0.05 });
    },
  };

  root.TartarusSound = {
    play(name) {
      const c = audio();
      if (!c || !SOUNDS[name]) return;
      try {
        SOUNDS[name](c);
      } catch (e) {
        /* Sound is decoration; a failure here must never block a move. */
      }
    },
    setEnabled(value) {
      enabled = !!value;
      if (!enabled && ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, Number(value) || 0));
      if (out) out.gain.value = volume;
    },
    get enabled() {
      return enabled;
    },
  };
})(window);
