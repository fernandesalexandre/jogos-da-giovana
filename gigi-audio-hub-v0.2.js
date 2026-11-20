/*!
 * gigi-audio-hub.js — Motor de Voz Expressiva Compartilhada & Kalimba Web Audio para o Hub "Vários em Um"
 * (Mapa Central + A Travessia da Lia + Ateliê de Delícias da Lia)
 * Autor: Nikola (PC2). 100% compatível com a API GigiAudio.create() do Atlas.
 * Sem dependências ou coleta de áudio. Vozes do aparelho podem usar rede.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GigiAudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MALE_HINTS = /(daniel|felipe|ant[oô]nio|nicolau|humberto|\bmale\b|masculin)/i;

  function scoreVoice(v, targetLang) {
    var name = (v && v.name) || '';
    var lang = (v && v.lang) || '';
    var prefix = (targetLang || 'pt-BR').slice(0, 2).toLowerCase();
    if (lang.toLowerCase().indexOf(prefix) !== 0) return -1;
    var score = lang.toLowerCase() === (targetLang || 'pt-BR').toLowerCase() ? 40 : 22;
    if (/^pt[-_]BR$/i.test(lang) && /google portugu[eê]s do brasil/i.test(name)) return 1000;
    if (MALE_HINTS.test(name)) return 5;
    if (/desktop/i.test(name)) score -= 25; // Rebaixa SAPI5 legada (Maria/Zira Desktop)
    if (/(thalita|giovanna|let[ií]cia|yara|leila|ana|jenny|aria)/i.test(name)) score += 65;
    else if (/francisca/i.test(name)) score += 60;
    else if (/(natural|neural|online)/i.test(name)) score += 55;
    else if (/(enhanced|premium|siri)/i.test(name)) score += 48;
    else if (/google/i.test(name)) score += 42;
    else if (/(luciana|vit[oó]ria|camila|raquel|helo[ií]sa|fernanda|samantha)/i.test(name)) score += 32;
    else if (/maria/i.test(name)) score += 5;
    return score;
  }

  /**
   * Divide um texto longo em micro-frases expressivas com pausas respiratórias
   * e contorno de entonação por pontuação (! = alegre, ? = convite, . = calmo),
   * suportando também tags bilíngues opcionais [en: One, two, three!] para o Ateliê.
   */
  function splitExpressiveChunks(input, baseRate, basePitch) {
    if (Array.isArray(input)) return input;
    var text = String(input || '').trim();
    if (!text) return [];

    // Separar tags explícitas [en: ...] se presentes
    var parts = text.split(/(\[en:[^\]]+\])/gi);
    var chunks = [];

    parts.forEach(function (part) {
      if (!part || !part.trim()) return;
      var mEn = part.match(/^\[en:\s*([^\]]+)\]$/i);
      if (mEn) {
        chunks.push({
          text: mEn[1].trim(),
          lang: 'en-US',
          rate: 0.96,
          pitch: 1.10,
          pause: 180
        });
        return;
      }
      // Dividir por frases terminadas em ! ? . mantendo a pontuação
      var sentences = part.match(/[^!?.]+[!?.\u2026]+|[^!?.]+$/g) || [part];
      sentences.forEach(function (s, idx) {
        var clean = s.trim();
        if (!clean) return;
        var isExclam = /!$/.test(clean);
        var isQuest = /\?$/.test(clean);
        var r = isExclam ? Math.min(1.06, baseRate + 0.04) : (isQuest ? Math.max(0.96, baseRate - 0.02) : baseRate);
        var p = isExclam ? Math.min(1.15, basePitch + 0.01) : (isQuest ? Math.min(1.15, basePitch + 0.01) : basePitch);
        chunks.push({
          text: clean,
          lang: 'pt-BR',
          rate: Number(r.toFixed(2)),
          pitch: Number(p.toFixed(2)),
          pause: 170
        });
      });
    });

    return chunks;
  }

  function create(opts) {
    opts = opts || {};
    var win = opts.window || (typeof window !== 'undefined' ? window : {});
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var cfg = {
      lang: opts.lang || 'pt-BR',
      rate: opts.rate != null ? opts.rate : 1.05,
      pitch: opts.pitch != null ? opts.pitch : 1.14,
      volume: opts.volume != null ? opts.volume : 1,
      maxSpeakMs: opts.maxSpeakMs || 15000,
      expressiveProsody: opts.expressiveProsody !== false,
      onCaption: opts.onCaption || function () {},
      onState: opts.onState || opts.onDiagnostics || function () {},
      onProblem: opts.onProblem || function () {}
    };

    var state = {
      unlocked: false,
      muted: !!opts.muted,
      ctx: null,
      notes: [],
      voice: null,
      enVoice: null,
      voicesChecked: false,
      clips: {},
      currentAudio: null,
      speakToken: 0,
      watchdog: null,
      chunkTimer: null,
      lastMode: 'none',
      lastError: null
    };

    var synth = win.speechSynthesis || null;
    var Utter = win.SpeechSynthesisUtterance || null;
    var AC = win.AudioContext || win.webkitAudioContext || null;

    function emit() { try { cfg.onState(getDiagnostics()); } catch (e) {} }
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

    function unlock() {
      if (state.unlocked) { resumeCtx(); return true; }
      try {
        if (AC) {
          state.ctx = state.ctx || new AC();
          resumeCtx();
          var b = state.ctx.createBuffer(1, 1, 22050);
          var s = state.ctx.createBufferSource();
          s.buffer = b; s.connect(state.ctx.destination);
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

    function stopSpeech() {
      state.speakToken++;
      state.notes.forEach(function(n){try{n.osc.stop();n.osc.disconnect();n.gain.disconnect();}catch(e){}});
      state.notes = [];
      if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
      if (state.chunkTimer) { clearTimeout(state.chunkTimer); state.chunkTimer = null; }
      try { if (synth) synth.cancel(); } catch (e) {}
      if (state.currentAudio) {
        try { state.currentAudio.pause(); } catch (e) {}
        state.currentAudio = null;
      }
    }

    function speak(text, o) {
      o = o || {};
      stopSpeech();
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
          ? splitExpressiveChunks(text, cfg.rate, cfg.pitch)
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
                state.chunkTimer = setTimeout(playNextChunk, c.pause != null ? c.pause : 180);
              }
            }
            u.onend = nextOrFinish;
            u.onerror = function (ev) {
              if (token !== state.speakToken || done) return;
              reportProblem('speech:' + ((ev && ev.error) || 'error'));
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

    // Paleta acústica Kalimba/Marimba compartilhada (Hub + Travessia + Ateliê de Delícias)
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
      if (state.muted || !state.unlocked || !state.ctx) return false;
      var notes = CHIMES[name] || CHIMES.soft;
      try {
        resumeCtx();
        var t0 = state.ctx.currentTime;
        notes.forEach(function (n) {
          var osc = state.ctx.createOscillator();
          var g = state.ctx.createGain();
          osc.type = 'sine'; osc.frequency.value = n[0];
          g.gain.setValueAtTime(0.0001, t0 + n[1]);
          g.gain.exponentialRampToValueAtTime(0.18 * cfg.volume, t0 + n[1] + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
          osc.connect(g); g.connect(state.ctx.destination);
          state.notes.push({osc:osc,gain:g});
          osc.start(t0 + n[1]); osc.stop(t0 + n[1] + n[2] + 0.02);
        });
        return true;
      } catch (e) { state.lastError = String(e && e.message || e); return false; }
    }

    function onVisibility() {
      if (!doc) return;
      if (doc.hidden) stopSpeech();
      else resumeCtx();
    }
    if (doc && doc.addEventListener) {
      doc.addEventListener('visibilitychange', onVisibility);
      if (win.addEventListener) win.addEventListener('pagehide', stopSpeech);
    }

    function dispose() {
      stopSpeech();
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange',onVisibility);
      if (win.removeEventListener) win.removeEventListener('pagehide',stopSpeech);
      if (synth && synth.removeEventListener) synth.removeEventListener('voiceschanged',refreshVoice);
      if (state.ctx && state.ctx.close) { try { state.ctx.close().catch(function(){}); } catch(e){} }
    }
    function registerClip(key, dataUri) {
      if (typeof dataUri === 'string' && /^data:audio\//.test(dataUri)) state.clips[key] = dataUri;
      else throw new Error('registerClip exige data URI audio/*');
    }
    function setMuted(m) { state.muted = !!m; if (state.muted) stopSpeech(); emit(); }

    function getDiagnostics() {
      var v = state.voice;
      var sc = v ? scoreVoice(v, cfg.lang) : -1;
      return {
        unlocked: state.unlocked,
        muted: state.muted,
        hasSpeechSynthesis: !!(synth && Utter),
        hasAudioContext: !!AC,
        ctxState: state.ctx ? state.ctx.state : null,
        voice: v ? { name: v.name, lang: v.lang, localService: !!v.localService, score: sc } : null,
        enVoice: state.enVoice ? { name: state.enVoice.name, lang: state.enVoice.lang } : null,
        voiceLooksFeminine: v ? !MALE_HINTS.test(v.name) : false,
        voiceIsNeuralNatural: sc >= 90,
        childLikeTimbreVerified: false,
        clips: Object.keys(state.clips),
        lastMode: state.lastMode,
        lastError: state.lastError
      };
    }

    return {
      unlock: unlock, speak: speak, stop: stopSpeech, chime: chime, dispose: dispose,
      registerClip: registerClip, setMuted: setMuted, getDiagnostics: getDiagnostics,
      refreshVoice: refreshVoice, splitExpressiveChunks: splitExpressiveChunks
    };
  }

  return { create: create, scoreVoice: scoreVoice, splitExpressiveChunks: splitExpressiveChunks };
});
