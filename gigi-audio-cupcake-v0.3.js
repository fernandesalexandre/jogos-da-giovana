/*!
 * gigi-audio-hub.js — Motor Único Consolidado de Voz & Efeitos Procedurais (v0.3)
 * Consolida a escolha de voz de Alexandre (L0: Google português do Brasil, rate 1.05, pitch 1.14, pausa 170ms)
 * com os efeitos procedurais do Cupcake (batedeira, confeitos, velinha por toque) e Formiguinhas,
 * atendendo integralmente aos critérios de engenharia e revisão do Atlas (9c89ac7f / 801373f1):
 *  1. Voz SFX = evento audível completo (com voiceGain próprio conectado ao masterSfxGain), orçamento máx. 3 eventos simultâneos.
 *  2. Rampa curta anti-clique (10ms) no voice-stealing; descarte imediato e desconexão em dispose().
 *  3. Eventos compostos (confeitos/marcha) agendados por fila de timers controlados: entram no orçamento ao disparar e são limpos por stopSfx/mudo/aba oculta/dispose.
 *  4. Cooldown de 140ms instrumentado com relógio injetável (opts.now) para testes determinísticos de rajada.
 *  5. speak() cancela apenas a fala anterior (stopSpeech), preservando efeitos SFX recém-iniciados; controles separados setMuted e setSfxMuted.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GigiAudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MALE_HINTS = /(daniel|felipe|ant[oô]nio|nicolau|humberto|\bmale\b|masculin)/i;

  var PENTATONIC_ANTS = {
    red:    587.33, // Ré5
    yellow: 659.25, // Mi5
    green:  739.99, // Fá#5
    blue:   880.00, // Lá5
    purple: 987.77, // Si5
    gold:  1174.66  // Ré6
  };

  function scoreVoice(v, targetLang) {
    var name = (v && v.name) || '';
    var lang = (v && v.lang) || '';
    var prefix = (targetLang || 'pt-BR').slice(0, 2).toLowerCase();
    if (lang.toLowerCase().indexOf(prefix) !== 0) return -1;
    var score = lang.toLowerCase() === (targetLang || 'pt-BR').toLowerCase() ? 40 : 22;

    if (MALE_HINTS.test(name)) return 5;
    if (/desktop/i.test(name)) score -= 25;

    if (/google\s+portugu[eê]s(\s+do\s+brasil)?/i.test(name)) score += 80; // 120 pts
    else if (/(thalita|giovanna|let[ií]cia|yara|leila|ana|jenny|aria)/i.test(name)) score += 65; // 105 pts
    else if (/francisca/i.test(name)) score += 60; // 100 pts
    else if (/(natural|neural|online)/i.test(name)) score += 55; // 95 pts
    else if (/(enhanced|premium|siri)/i.test(name)) score += 48; // 88 pts
    else if (/google/i.test(name)) score += 42; // 82 pts
    else if (/(luciana|vit[oó]ria|camila|raquel|helo[ií]sa|fernanda|samantha)/i.test(name)) score += 32; // 72 pts
    else if (/maria/i.test(name)) score += 5;

    return score;
  }

  function splitExpressiveChunks(input, baseRate, basePitch, basePauseMs) {
    if (Array.isArray(input)) return input;
    var text = String(input || '').trim();
    if (!text) return [];
    var r0 = baseRate != null ? baseRate : 1.05;
    var p0 = basePitch != null ? basePitch : 1.14;
    var pause0 = basePauseMs != null ? basePauseMs : 170;

    var parts = text.split(/(\[en:[^\]]+\])/gi);
    var chunks = [];

    parts.forEach(function (part) {
      if (!part || !part.trim()) return;
      var mEn = part.match(/^\[en:\s*([^\]]+)\]$/i);
      if (mEn) {
        chunks.push({ text: mEn[1].trim(), lang: 'en-US', rate: 1.00, pitch: 1.12, pause: pause0 });
        return;
      }
      var sentences = part.match(/[^!?.]+[!?.\u2026]+|[^!?.]+$/g) || [part];
      sentences.forEach(function (s, idx) {
        var clean = s.trim();
        if (!clean) return;
        var isExclam = /!$/.test(clean);
        var isQuest = /\?$/.test(clean);
        var r = isExclam ? Math.min(1.06, r0 + 0.01) : (isQuest ? Math.max(1.03, r0 - 0.02) : r0);
        var p = isExclam ? Math.min(1.15, p0 + 0.01) : (isQuest ? Math.min(1.15, p0 + 0.01) : p0);
        chunks.push({
          text: clean,
          lang: 'pt-BR',
          rate: Number(r.toFixed(2)),
          pitch: Number(p.toFixed(2)),
          pause: idx === sentences.length - 1 ? 100 : pause0
        });
      });
    });

    return chunks;
  }

  function create(opts) {
    opts = opts || {};
    var win = opts.window || (typeof window !== 'undefined' ? window : {});
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var nowFn = opts.now || function () { return Date.now(); };

    var cfg = {
      lang: opts.lang || 'pt-BR',
      rate: opts.rate != null ? opts.rate : 1.05,
      pitch: opts.pitch != null ? opts.pitch : 1.14,
      pauseMs: opts.pauseMs != null ? opts.pauseMs : 170,
      volume: opts.volume != null ? opts.volume : 1,
      maxSpeakMs: opts.maxSpeakMs || 15000,
      maxPolyphony: opts.maxPolyphony != null ? opts.maxPolyphony : 3,
      cooldownMs: opts.cooldownMs != null ? opts.cooldownMs : 140,
      fadeRampSec: opts.fadeRampSec != null ? opts.fadeRampSec : 0.010, // Rampa curta 10ms anti-clique
      expressiveProsody: opts.expressiveProsody !== false,
      onCaption: opts.onCaption || function () {},
      onDiagnostics: opts.onDiagnostics || opts.onState || function () {},
      onState: opts.onState || opts.onDiagnostics || function () {},
      onProblem: opts.onProblem || function () {}
    };

    var state = {
      unlocked: false,
      muted: !!opts.muted,
      sfxMuted: !!opts.sfxMuted,
      disposed: false,
      ctx: null,
      masterSfxGain: null,
      voice: null,
      enVoice: null,
      voicesChecked: false,
      clips: {},
      currentAudio: null,
      activeUtterance: null,
      activeVoices: [],     // Lista de eventos SFX audíveis completos em curso (máx cfg.maxPolyphony)
      sfxTimers: [],        // Timers de grãos/eventos futuros agendados
      lastSfxAtByKey: {},   // Relógio de cooldown por categoria de evento
      voiceSeq: 0,
      stolenCount: 0,
      cooldownDrops: 0,
      peakActiveVoices: 0,
      speakToken: 0,
      watchdog: null,
      chunkTimer: null,
      lastMode: 'none',
      lastError: null
    };

    var synth = win.speechSynthesis || null;
    var Utter = win.SpeechSynthesisUtterance || null;
    var AC = win.AudioContext || win.webkitAudioContext || null;

    function emit() {
      var d = getDiagnostics();
      try { cfg.onState(d); } catch (e) {}
      if (cfg.onDiagnostics !== cfg.onState) {
        try { cfg.onDiagnostics(d); } catch (e) {}
      }
    }

    function reportProblem(reason) {
      state.lastError = reason;
      emit();
      try { cfg.onProblem(reason, getDiagnostics()); } catch (e) {}
    }

    function pickBestVoice(targetLang) {
      if (!synth || !synth.getVoices) return null;
      var voices = synth.getVoices() || [];
      state.voicesChecked = true;
      var scored = voices
        .map(function (v) { return { v: v, s: scoreVoice(v, targetLang) }; })
        .filter(function (x) { return x.s >= 0; })
        .sort(function (a, b) { return b.s - a.s; });
      return scored.length ? scored[0].v : null;
    }

    function refreshVoice() {
      state.voice = pickBestVoice(cfg.lang);
      state.enVoice = pickBestVoice('en-US');
      emit();
    }

    if (synth) {
      refreshVoice();
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', refreshVoice);
      else if ('onvoiceschanged' in synth) synth.onvoiceschanged = refreshVoice;
    }

    function ensureMasterCtx() {
      if (!AC) return null;
      if (!state.ctx) {
        state.ctx = new AC();
      }
      resumeCtx();
      if (!state.masterSfxGain && state.ctx.createGain) {
        state.masterSfxGain = state.ctx.createGain();
        if (state.masterSfxGain.gain && state.masterSfxGain.gain.setValueAtTime) {
          state.masterSfxGain.gain.setValueAtTime(0.85 * cfg.volume, state.ctx.currentTime || 0);
        }
        state.masterSfxGain.connect(state.ctx.destination);
      }
      return state.ctx;
    }

    function unlock() {
      if (state.disposed) return false;
      if (state.unlocked) { resumeCtx(); return true; }
      try {
        var c = ensureMasterCtx();
        if (c && c.createBuffer) {
          var b = c.createBuffer(1, 1, 22050);
          var s = c.createBufferSource();
          s.buffer = b; s.connect(c.destination);
          if (s.start) s.start(0); else if (s.noteOn) s.noteOn(0);
        }
        state.unlocked = true;
      } catch (e) { state.lastError = String(e && e.message || e); }
      emit();
      return state.unlocked;
    }

    function resumeCtx() {
      try { if (state.ctx && state.ctx.state === 'suspended') state.ctx.resume(); } catch (e) {}
    }

    /**
     * Finaliza uma voz SFX específica.
     * - Se immediate === true (ex.: dispose/stopSfx), cancela agendamentos, zera ganho e desconecta na hora.
     * - Se immediate === false (ex.: voice-stealing por limite de polifonia), aplica rampa curta de 10ms anti-clique.
     */
    function terminateVoice(vObj, immediate) {
      if (!vObj || vObj.ended) return;
      vObj.ended = true;
      if (vObj.cleanupTimer) {
        clearTimeout(vObj.cleanupTimer);
        vObj.cleanupTimer = null;
      }
      var idx = state.activeVoices.indexOf(vObj);
      if (idx >= 0) state.activeVoices.splice(idx, 1);

      var c = state.ctx;
      var nowT = (c && c.currentTime) || 0;
      var vg = vObj.voiceGain;

      if (!immediate && c && vg && vg.gain && vg.gain.linearRampToValueAtTime) {
        try {
          if (vg.gain.cancelScheduledValues) vg.gain.cancelScheduledValues(nowT);
          var curVal = typeof vg.gain.value === 'number' ? Math.max(0.0001, vg.gain.value) : 0.08;
          if (vg.gain.setValueAtTime) vg.gain.setValueAtTime(curVal, nowT);
          vg.gain.linearRampToValueAtTime(0.0001, nowT + cfg.fadeRampSec);
        } catch (e) {}
        vObj.sources.forEach(function (src) {
          try { if (src.stop) src.stop(nowT + cfg.fadeRampSec + 0.002); } catch (e) {}
        });
        return;
      }

      // Descarte imediato
      if (vg && vg.gain) {
        try {
          if (vg.gain.cancelScheduledValues) vg.gain.cancelScheduledValues(nowT);
          if (vg.gain.setValueAtTime) vg.gain.setValueAtTime(0, nowT);
        } catch (e) {}
      }
      vObj.sources.forEach(function (src) {
        try { if (src.stop) src.stop(0); } catch (e) {}
        try { if (src.disconnect) src.disconnect(); } catch (e) {}
      });
      if (vg && vg.disconnect) {
        try { vg.disconnect(); } catch (e) {}
      }
    }

    function stopSfx() {
      while (state.sfxTimers.length) {
        clearTimeout(state.sfxTimers.pop());
      }
      var copy = state.activeVoices.slice();
      copy.forEach(function (vObj) { terminateVoice(vObj, true); });
      state.activeVoices.length = 0;
    }

    function stopSpeech() {
      state.speakToken++;
      if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
      if (state.chunkTimer) { clearTimeout(state.chunkTimer); state.chunkTimer = null; }
      if (state.activeUtterance) {
        state.activeUtterance.onend = null;
        state.activeUtterance.onerror = null;
        state.activeUtterance = null;
      }
      try { if (synth) synth.cancel(); } catch (e) {}
      if (state.currentAudio) {
        try { state.currentAudio.pause(); } catch (e) {}
        state.currentAudio = null;
      }
    }

    function stopAll() {
      stopSpeech();
      stopSfx();
      emit();
    }

    /**
     * Aloca um evento audível completo (SfxVoice) respeitando:
     * - estado unlocked / muted / sfxMuted / disposed
     * - cooldown por chave (skipCooldown=true apenas para sub-grãos internos espaçados)
     * - orçamento máximo de polifonia (cfg.maxPolyphony = 3), aplicando rampa anti-clique na voz mais antiga se cheio
     */
    function allocateSfxVoice(kind, durationMs, skipCooldown) {
      if (state.disposed || state.muted || state.sfxMuted || !state.unlocked) return null;
      var c = ensureMasterCtx();
      if (!c || !c.createGain) return null;

      var nowMs = nowFn();
      if (!skipCooldown && cfg.cooldownMs > 0) {
        var lastAt = state.lastSfxAtByKey[kind];
        if (lastAt != null && (nowMs - lastAt) < cfg.cooldownMs) {
          state.cooldownDrops++;
          return null;
        }
        state.lastSfxAtByKey[kind] = nowMs;
      }

      while (state.activeVoices.length >= cfg.maxPolyphony) {
        var oldest = state.activeVoices[0];
        state.stolenCount++;
        terminateVoice(oldest, false); // Rampa curta 10ms anti-clique
      }

      var vg = c.createGain();
      var dest = state.masterSfxGain || c.destination;
      vg.connect(dest);

      var vObj = {
        id: ++state.voiceSeq,
        kind: kind,
        voiceGain: vg,
        sources: [],
        ended: false,
        cleanupTimer: null
      };

      state.activeVoices.push(vObj);
      if (state.activeVoices.length > state.peakActiveVoices) {
        state.peakActiveVoices = state.activeVoices.length;
      }

      var ttl = Math.max(40, Math.ceil(durationMs || 250) + 30);
      vObj.cleanupTimer = setTimeout(function () {
        if (vObj.ended) return;
        vObj.ended = true;
        var i = state.activeVoices.indexOf(vObj);
        if (i >= 0) state.activeVoices.splice(i, 1);
        try { if (vg.disconnect) vg.disconnect(); } catch (e) {}
      }, ttl);

      return vObj;
    }

    function scheduleSfx(delayMs, fn) {
      if (state.disposed || state.muted || state.sfxMuted || !state.unlocked) return;
      if (!delayMs || delayMs <= 0) {
        fn();
        return;
      }
      var tid = setTimeout(function () {
        var i = state.sfxTimers.indexOf(tid);
        if (i >= 0) state.sfxTimers.splice(i, 1);
        if (state.disposed || state.muted || state.sfxMuted || !state.unlocked) return;
        fn();
      }, delayMs);
      state.sfxTimers.push(tid);
    }

    /**
     * speak(text, opts)
     * Cancela apenas a fala anterior (stopSpeech), preservando efeitos SFX em curso (a menos que opts.stopSfx=true).
     */
    function speak(text, o) {
      o = o || {};
      if (state.disposed) return { mode: 'disposed' };
      stopSpeech();
      if (o.stopSfx) stopSfx();

      var token = state.speakToken;
      var done = false;
      state.lastError = null;

      var displayCaption = Array.isArray(text)
        ? text.map(function (c) { return c.text; }).join(' ')
        : String(text || '').replace(/\[en:\s*([^\]]+)\]/gi, '$1');

      function finish() {
        if (done || token !== state.speakToken) return;
        done = true;
        if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
        if (state.chunkTimer) { clearTimeout(state.chunkTimer); state.chunkTimer = null; }
        if (o.onEnd) try { o.onEnd(); } catch (e) {}
      }

      try { cfg.onCaption(displayCaption); } catch (e) {}

      if (state.muted || !state.unlocked) {
        state.lastMode = 'caption-only'; emit();
        setTimeout(finish, 0);
        return { mode: 'caption-only' };
      }

      var clip = o.key && state.clips[o.key];
      if (clip && (win.Audio || (typeof Audio !== 'undefined'))) {
        try {
          var A = win.Audio || Audio;
          var a = new A(clip);
          a.volume = cfg.volume;
          a.onended = finish;
          a.onerror = function () { speechSequence(); };
          state.currentAudio = a;
          var p = a.play();
          if (p && p.catch) p.catch(function () { speechSequence(); });
          state.lastMode = 'clip'; emit();
          armWatchdog(token, finish);
          return { mode: 'clip' };
        } catch (e) { state.lastError = String(e && e.message || e); }
      }

      return speechSequence();

      function speechSequence() {
        if (token !== state.speakToken || done) return { mode: 'stale' };
        if (!synth || !Utter) {
          state.lastMode = 'caption-only';
          reportProblem('speech-unavailable');
          setTimeout(finish, 0);
          return { mode: 'caption-only' };
        }
        if (!state.voice) refreshVoice();

        var chunks = cfg.expressiveProsody
          ? splitExpressiveChunks(text, cfg.rate, cfg.pitch, cfg.pauseMs)
          : [{ text: displayCaption, lang: cfg.lang, rate: cfg.rate, pitch: cfg.pitch, pause: 0 }];

        if (!chunks.length) {
          setTimeout(finish, 0);
          return { mode: 'caption-only' };
        }

        state.lastMode = 'speech'; emit();
        armWatchdog(token, finish);

        var sequenceVoice = state.voice, sequenceEnVoice = state.enVoice;
        var idx = 0;
        function playNextChunk() {
          if (token !== state.speakToken || done) return;
          if (idx >= chunks.length) { finish(); return; }
          var c = chunks[idx++];
          try {
            var u = new Utter(c.text);
            state.activeUtterance = u;
            var isEn = /^en/i.test(c.lang || '');
            var chosenVoice = isEn ? sequenceEnVoice : sequenceVoice;
            u.lang = (chosenVoice && chosenVoice.lang) || c.lang || cfg.lang;
            if (chosenVoice) u.voice = chosenVoice;
            u.rate = c.rate != null ? c.rate : cfg.rate;
            u.pitch = c.pitch != null ? c.pitch : cfg.pitch;
            u.volume = cfg.volume;

            var chunkDone = false;
            function nextOrFinish() {
              if (chunkDone || token !== state.speakToken || done) return;
              chunkDone = true;
              if (idx >= chunks.length) {
                finish();
              } else {
                state.chunkTimer = setTimeout(playNextChunk, c.pause != null ? c.pause : cfg.pauseMs);
              }
            }
            u.onend = nextOrFinish;
            u.onerror = function (ev) {
              if (chunkDone || token !== state.speakToken || done) return;
              chunkDone = true;
              var errCode = (ev && ev.error) || 'error';
              if (errCode !== 'canceled' && errCode !== 'interrupted') {
                try { synth.cancel(); } catch (e) {}
                reportProblem('speech:' + errCode);
              }
              finish();
            };
            synth.speak(u);
          } catch (e) {
            reportProblem(String(e && e.message || e));
            finish();
          }
        }

        playNextChunk();
        return { mode: 'speech', chunks: chunks.length };
      }
    }

    function armWatchdog(token, finish) {
      if (state.watchdog) clearTimeout(state.watchdog);
      state.watchdog = setTimeout(function () {
        if (token !== state.speakToken) return;
        try { if (synth) synth.cancel(); } catch (e) {}
        reportProblem('speech-timeout');
        finish();
      }, cfg.maxSpeakMs);
    }

    // ---------- Chimes e Efeitos Procedurais sob Orçamento de Vozes ----------
    var CHIMES = {
      ok:       [[523.25, 0.00, 0.12], [659.25, 0.09, 0.16]],
      undo:     [[440.00, 0.00, 0.10], [349.23, 0.08, 0.14]],
      soft:     [[392.00, 0.00, 0.18]],
      embarcar: [[392.00, 0.00, 0.14], [523.25, 0.11, 0.14], [659.25, 0.22, 0.22]],
      hub:      [[587.33, 0.00, 0.12], [739.99, 0.09, 0.14], [880.00, 0.18, 0.22]],
      confeitar:[[659.25, 0.00, 0.10], [783.99, 0.08, 0.12], [1046.50, 0.16, 0.20]],
      forno:    [[523.25, 0.00, 0.14], [659.25, 0.12, 0.14], [783.99, 0.24, 0.14], [1046.50, 0.36, 0.26]]
    };

    function chime(name) {
      var notes = CHIMES[name] || CHIMES.soft;
      var totalDurMs = Math.ceil((notes[notes.length - 1][1] + notes[notes.length - 1][2]) * 1000) + 20;
      var vObj = allocateSfxVoice('chime:' + (name || 'soft'), totalDurMs, false);
      if (!vObj) return false;
      try {
        var c = state.ctx;
        var t0 = c.currentTime || 0;
        if (vObj.voiceGain.gain && vObj.voiceGain.gain.setValueAtTime) {
          vObj.voiceGain.gain.setValueAtTime(1, t0);
        }
        notes.forEach(function (n) {
          var osc = c.createOscillator();
          var g = c.createGain();
          osc.type = 'sine';
          if (osc.frequency.setValueAtTime) osc.frequency.setValueAtTime(n[0], t0 + n[1]);
          else osc.frequency.value = n[0];
          g.gain.setValueAtTime(0.0001, t0 + n[1]);
          g.gain.exponentialRampToValueAtTime(0.13, t0 + n[1] + 0.018);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
          osc.connect(g); g.connect(vObj.voiceGain);
          osc.start(t0 + n[1]); osc.stop(t0 + n[1] + n[2] + 0.015);
          vObj.sources.push(osc);
        });
        return true;
      } catch (e) {
        terminateVoice(vObj, true);
        state.lastError = String(e && e.message || e);
        return false;
      }
    }

    // 1. Batedeira / Liquidificador (1 voz SFX completa contendo motor + LFO + filtro lowpass)
    function sfxBlender(durationMs) {
      var durMs = durationMs || 800;
      var vObj = allocateSfxVoice('blender', durMs, false);
      if (!vObj) return false;
      try {
        var c = state.ctx;
        var dur = durMs / 1000;
        var t0 = c.currentTime || 0;
        var motor = c.createOscillator();
        var lfo = c.createOscillator();
        var lfoGain = c.createGain();
        var filter = c.createBiquadFilter ? c.createBiquadFilter() : null;

        motor.type = 'sawtooth';
        if (motor.frequency.setValueAtTime) {
          motor.frequency.setValueAtTime(82, t0);
          motor.frequency.exponentialRampToValueAtTime(145, t0 + dur * 0.45);
          motor.frequency.exponentialRampToValueAtTime(95, t0 + dur);
        }
        lfo.type = 'sine';
        if (lfo.frequency.setValueAtTime) lfo.frequency.setValueAtTime(13, t0);
        if (lfoGain.gain.setValueAtTime) lfoGain.gain.setValueAtTime(20, t0);

        vObj.voiceGain.gain.setValueAtTime(0.0001, t0);
        vObj.voiceGain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.04);
        vObj.voiceGain.gain.setValueAtTime(0.11, t0 + Math.max(0.05, dur - 0.06));
        vObj.voiceGain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

        lfo.connect(lfoGain);
        lfoGain.connect(motor.frequency);
        if (filter) {
          filter.type = 'lowpass';
          if (filter.frequency.setValueAtTime) filter.frequency.setValueAtTime(380, t0);
          motor.connect(filter);
          filter.connect(vObj.voiceGain);
        } else {
          motor.connect(vObj.voiceGain);
        }

        motor.start(t0); motor.stop(t0 + dur + 0.015);
        lfo.start(t0); lfo.stop(t0 + dur + 0.015);
        vObj.sources.push(motor, lfo);
        return true;
      } catch (e) {
        terminateVoice(vObj, true);
        state.lastError = String(e && e.message || e);
        return false;
      }
    }

    // 2. Confeitos (agendados via scheduleSfx para respeitar limite de polifonia e cancelamento futuro)
    function sfxSprinkles() {
      var nowMs = nowFn();
      var lastAt = state.lastSfxAtByKey['sprinkles'];
      if (lastAt != null && (nowMs - lastAt) < cfg.cooldownMs) {
        state.cooldownDrops++;
        return false;
      }
      if (state.disposed || state.muted || state.sfxMuted || !state.unlocked) return false;
      state.lastSfxAtByKey['sprinkles'] = nowMs;

      var freqs = [1174.66, 1318.51, 1479.98, 1760.00, 1975.53];
      freqs.forEach(function (f, i) {
        scheduleSfx(i * 50, function () {
          var vObj = allocateSfxVoice('sprinkleGrain', 85, true);
          if (!vObj) return;
          try {
            var c = state.ctx;
            var t0 = c.currentTime || 0;
            var osc = c.createOscillator();
            osc.type = i % 2 === 0 ? 'sine' : 'triangle';
            if (osc.frequency.setValueAtTime) osc.frequency.setValueAtTime(f, t0);
            else osc.frequency.value = f;
            vObj.voiceGain.gain.setValueAtTime(0.0001, t0);
            vObj.voiceGain.gain.exponentialRampToValueAtTime(0.10, t0 + 0.008);
            vObj.voiceGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.070);
            osc.connect(vObj.voiceGain);
            osc.start(t0); osc.stop(t0 + 0.080);
            vObj.sources.push(osc);
          } catch (e) { terminateVoice(vObj, true); }
        });
      });
      return true;
    }

    // 3. Assoprar Velinha por toque (1 voz SFX completa contendo sopro filtrado + brilho)
    function sfxBlowCandle() {
      var vObj = allocateSfxVoice('blowCandle', 620, false);
      if (!vObj) return false;
      try {
        var c = state.ctx;
        var t0 = c.currentTime || 0;
        if (vObj.voiceGain.gain.setValueAtTime) vObj.voiceGain.gain.setValueAtTime(1, t0);

        if (c.createBuffer && c.createBufferSource) {
          var sr = c.sampleRate || 22050;
          var len = Math.floor(sr * 0.38);
          var buf = c.createBuffer(1, len, sr);
          var data = buf.getChannelData ? buf.getChannelData(0) : null;
          if (data) {
            for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1);
          }
          var noise = c.createBufferSource();
          noise.buffer = buf;
          var ng = c.createGain();
          ng.gain.setValueAtTime(0.0001, t0);
          ng.gain.exponentialRampToValueAtTime(0.13, t0 + 0.05);
          ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.37);

          if (c.createBiquadFilter) {
            var bp = c.createBiquadFilter();
            bp.type = 'bandpass';
            if (bp.frequency.setValueAtTime) {
              bp.frequency.setValueAtTime(1300, t0);
              bp.frequency.exponentialRampToValueAtTime(360, t0 + 0.36);
            }
            if (bp.Q && bp.Q.setValueAtTime) bp.Q.setValueAtTime(2.5, t0);
            noise.connect(bp); bp.connect(ng);
          } else {
            noise.connect(ng);
          }
          ng.connect(vObj.voiceGain);
          noise.start(t0); noise.stop(t0 + 0.38);
          vObj.sources.push(noise);
        }

        [[1318.51, 0.34, 0.12], [1760.00, 0.42, 0.18]].forEach(function (n) {
          var osc = c.createOscillator();
          var g = c.createGain();
          osc.type = 'sine';
          if (osc.frequency.setValueAtTime) osc.frequency.setValueAtTime(n[0], t0 + n[1]);
          g.gain.setValueAtTime(0.0001, t0 + n[1]);
          g.gain.exponentialRampToValueAtTime(0.10, t0 + n[1] + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
          osc.connect(g); g.connect(vObj.voiceGain);
          osc.start(t0 + n[1]); osc.stop(t0 + n[1] + n[2] + 0.015);
          vObj.sources.push(osc);
        });
        return true;
      } catch (e) {
        terminateVoice(vObj, true);
        state.lastError = String(e && e.message || e);
        return false;
      }
    }

    // 4. Evento discreto de Formiguinha por cor/grupo (com cooldown 140ms e limite de 3 vozes)
    function antStep(colorKey) {
      var vObj = allocateSfxVoice('antStep', 125, false);
      if (!vObj) return false;
      try {
        var c = state.ctx;
        var t0 = c.currentTime || 0;
        var f = PENTATONIC_ANTS[colorKey] || PENTATONIC_ANTS.red;
        var osc = c.createOscillator();
        var sub = c.createOscillator();
        osc.type = 'sine';
        sub.type = 'triangle';
        if (osc.frequency.setValueAtTime) osc.frequency.setValueAtTime(f, t0);
        else osc.frequency.value = f;
        if (sub.frequency.setValueAtTime) sub.frequency.setValueAtTime(f * 2, t0);
        else sub.frequency.value = f * 2;

        vObj.voiceGain.gain.setValueAtTime(0.0001, t0);
        vObj.voiceGain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.010);
        vObj.voiceGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.110);

        osc.connect(vObj.voiceGain);
        sub.connect(vObj.voiceGain);
        osc.start(t0); osc.stop(t0 + 0.120);
        sub.start(t0); sub.stop(t0 + 0.060);
        vObj.sources.push(osc, sub);
        return true;
      } catch (e) {
        terminateVoice(vObj, true);
        return false;
      }
    }

    function onVisibility() {
      if (!doc) return;
      if (doc.hidden) stopAll();
      else resumeCtx();
    }
    if (doc && doc.addEventListener) {
      doc.addEventListener('visibilitychange', onVisibility);
      if (win.addEventListener) win.addEventListener('pagehide', stopAll);
    }

    function dispose() {
      state.disposed = true;
      stopAll();
      if (state.ctx && state.ctx.close) { try { state.ctx.close().catch(function(){}); } catch(e){} }
      if (state.masterSfxGain && state.masterSfxGain.disconnect) {
        try { state.masterSfxGain.disconnect(); } catch (e) {}
      }
      if (doc && doc.removeEventListener) {
        try { doc.removeEventListener('visibilitychange', onVisibility); } catch (e) {}
      }
      if (win && win.removeEventListener) {
        try { win.removeEventListener('pagehide', stopAll); } catch (e) {}
      }
      if (synth && typeof synth.removeEventListener === 'function') {
        try { synth.removeEventListener('voiceschanged', refreshVoice); } catch (e) {}
      }
      emit();
    }

    function registerClip(key, dataUri) {
      if (typeof dataUri === 'string' && /^data:audio\//.test(dataUri)) state.clips[key] = dataUri;
      else throw new Error('registerClip exige data URI audio/*');
    }
    function setMuted(m) { state.muted = !!m; if (state.muted) stopAll(); else emit(); }
    function setSfxMuted(m) { state.sfxMuted = !!m; if (state.sfxMuted) stopSfx(); emit(); }

    function getDiagnostics() {
      var v = state.voice;
      var sc = v ? scoreVoice(v, cfg.lang) : -1;
      return {
        unlocked: state.unlocked,
        muted: state.muted,
        sfxMuted: state.sfxMuted,
        disposed: state.disposed,
        hasSpeechSynthesis: !!(synth && Utter),
        hasAudioContext: !!AC,
        ctxState: state.ctx ? state.ctx.state : null,
        rate: cfg.rate,
        pitch: cfg.pitch,
        pauseMs: cfg.pauseMs,
        maxPolyphony: cfg.maxPolyphony,
        cooldownMs: cfg.cooldownMs,
        activeVoicesCount: state.activeVoices.length,
        peakActiveVoices: state.peakActiveVoices,
        pendingSfxTimers: state.sfxTimers.length,
        stolenVoicesCount: state.stolenCount,
        cooldownDropsCount: state.cooldownDrops,
        voice: v ? { name: v.name, lang: v.lang, localService: !!v.localService, score: sc } : null,
        enVoice: state.enVoice ? { name: state.enVoice.name, lang: state.enVoice.lang } : null,
        voiceLooksFeminine: v ? !MALE_HINTS.test(v.name) : false,
        voiceIsGooglePtBr: v ? /google\s+portugu[eê]s/i.test(v.name) : false,
        childLikeTimbreVerified: false,
        clips: Object.keys(state.clips),
        lastMode: state.lastMode,
        lastError: state.lastError
      };
    }

    return {
      unlock: unlock, speak: speak, stop: stopAll, stopSpeech: stopSpeech, stopSfx: stopSfx,
      dispose: dispose, chime: chime,
      sfxBlender: sfxBlender, sfxSprinkles: sfxSprinkles, sfxBlowCandle: sfxBlowCandle,
      antStep: antStep, scheduleSfx: scheduleSfx,
      registerClip: registerClip, setMuted: setMuted, setSfxMuted: setSfxMuted,
      getDiagnostics: getDiagnostics, refreshVoice: refreshVoice,
      splitExpressiveChunks: splitExpressiveChunks
    };
  }

  return {
    create: create,
    scoreVoice: scoreVoice,
    splitExpressiveChunks: splitExpressiveChunks,
    PENTATONIC_ANTS: PENTATONIC_ANTS
  };
});
