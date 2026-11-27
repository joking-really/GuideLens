(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (window.ScrollCraft && typeof window.ScrollCraft.mount === 'function') {
    window.ScrollCraft.mount(document);
  }

  // Sticky glass nav state once scrolled past the hero
  var syncNav = function () {
    document.documentElement.classList.toggle('is-scrolled', (window.scrollY || window.pageYOffset) > 48);
  };
  syncNav();
  window.addEventListener('scroll', syncNav, { passive: true });

  // Mobile nav drawer
  var navToggle = document.querySelector('.nav-toggle');
  var navMenu = document.getElementById('site-menu');
  if (navToggle && navMenu) {
    navToggle.addEventListener('click', function () {
      var open = navToggle.getAttribute('aria-expanded') === 'true';
      navToggle.setAttribute('aria-expanded', String(!open));
      navMenu.classList.toggle('is-open', !open);
    });
    navMenu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        navToggle.setAttribute('aria-expanded', 'false');
        navMenu.classList.remove('is-open');
      });
    });
  }

  // Act 2: Hairline Reticle Session Simulator
  var simAct = document.getElementById('simulator');
  var simViewport = document.getElementById('sim-viewport');
  var simStatus = document.getElementById('sim-status');
  var simStatusText = simStatus ? simStatus.querySelector('.sim-status__text') : null;
  var simTag = null;
  var simCaption = document.getElementById('sim-caption');
  var simHitbox = document.getElementById('sim-hitbox');
  var simTabs = Array.prototype.slice.call(document.querySelectorAll('[data-sim-step]'));

  var SIM_STATES = [
    {
      state: 'searching',
      tag: 'Ctrl + Space',
      status: 'Command bar ready on Ctrl + Space',
      caption: 'Step 1 of 3: Press Ctrl + Space or click the target to test lock.'
    },
    {
      state: 'locked',
      tag: 'UIA rect locked',
      status: 'IUIAutomation snapped onto Run Workflow',
      caption: 'Step 2 of 3: Click inside the highlighted Run Workflow button to advance.'
    },
    {
      state: 'remembered',
      tag: 'Graph saved',
      status: 'Step completed and stored in local graph',
      caption: 'Step 3 of 3: Workflow saved for future recall. Click again to replay.'
    }
  ];

  var currentPhase = 0;
  var manualOverride = false;
  var lastScrollPhase = 0;

  function applyPhase(idx) {
    idx = Math.max(0, Math.min(2, idx));
    currentPhase = idx;
    var info = SIM_STATES[idx];
    if (simViewport) {
      simViewport.setAttribute('data-phase', String(idx));
      simViewport.setAttribute('aria-labelledby', 'sim-tab-' + idx);
    }
    if (simStatus) simStatus.setAttribute('data-state', info.state);
    if (simStatusText) simStatusText.textContent = info.status;
    if (simTag) simTag.textContent = info.tag;
    if (simCaption) simCaption.textContent = info.caption;
    simTabs.forEach(function (tab, i) {
      var active = i === idx;
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
    });
  }

  simTabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () {
      manualOverride = true;
      applyPhase(i);
    });
    tab.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      var dir = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
      var next = (i + dir + simTabs.length) % simTabs.length;
      manualOverride = true;
      applyPhase(next);
      simTabs[next].focus({ preventScroll: true });
    });
  });

  if (simHitbox) {
    simHitbox.addEventListener('click', function () {
      manualOverride = true;
      applyPhase((currentPhase + 1) % SIM_STATES.length);
    });
  }

  if (simAct && !reduce) {
    var syncSimScroll = function () {
      var raw = parseFloat(simAct.style.getPropertyValue('--sc-p'));
      if (isNaN(raw)) return;
      var scrollPhase = raw < 0.34 ? 0 : raw < 0.68 ? 1 : 2;
      if (scrollPhase !== lastScrollPhase) {
        lastScrollPhase = scrollPhase;
        manualOverride = false;
      }
      if (!manualOverride && scrollPhase !== currentPhase) {
        applyPhase(scrollPhase);
      }
    };
    window.addEventListener('scroll', syncSimScroll, { passive: true });
  }

  // Act 3: Before / After Grounding Wipe
  var wipeEl = document.getElementById('grounding-wipe');
  var wipeRange = document.getElementById('wipe-range');
  if (wipeEl && wipeRange) {
    var updateWipe = function () {
      var v = parseFloat(wipeRange.value);
      if (!isNaN(v)) {
        wipeEl.style.setProperty('--wipe', v + '%');
        var divider = wipeEl.querySelector('.wipe__divider');
        if (divider) {
          divider.style.left = '0';
          divider.style.transform = 'translate3d(' + ((wipeEl.clientWidth * v) / 100).toFixed(1) + 'px, 0, 0)';
        }
      }
    };
    wipeRange.addEventListener('input', updateWipe);
    window.addEventListener('resize', updateWipe, { passive: true });
    updateWipe();
  }

  // Act 4: Companions Switcher & Pose Switcher
  var COMPANIONS = {
    mochi: {
      name: 'Mochi',
      summary: 'Minimal ivory feline that perches near targets with tiny-voca F2 voice cues.'
    },
    byte: {
      name: 'Byte',
      summary: 'Matte obsidian visor bot tuned for terminal workflows with tiny-voca M2 voice cues.'
    },
    sora: {
      name: 'Sora',
      summary: 'Serene floating halo sprite that tracks active window focus with F2 voice cues.'
    },
    flow: {
      name: 'Flow',
      summary: 'Frosted geometric concentric orb for low-distraction workspaces with M2 voice cues.'
    }
  };

  var compTabs = Array.prototype.slice.call(document.querySelectorAll('[data-companion]'));
  var compDetail = document.getElementById('comp-detail');
  var compName = document.getElementById('comp-name');
  var compSummary = document.getElementById('comp-summary');

  compTabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () {
      var id = tab.getAttribute('data-companion');
      var data = COMPANIONS[id];
      if (!data) return;
      compTabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.setAttribute('tabindex', on ? '0' : '-1');
      });
      if (compName) compName.textContent = data.name;
      if (compSummary) compSummary.textContent = data.summary;
      if (compDetail) compDetail.setAttribute('aria-labelledby', tab.id);
    });

    tab.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      var next = (i + (e.key === 'ArrowDown' ? 1 : -1) + compTabs.length) % compTabs.length;
      compTabs[next].click();
      compTabs[next].focus({ preventScroll: true });
    });
  });

  var POSES = {
    peek: {
      src: './assets/screenshot-overlay-peeking.png',
      alt: 'Mochi overlay companion peeking while Screen Day is on',
      caption: 'Screen Day idle perch'
    },
    dance: {
      src: './assets/screenshot-overlay-dance.png',
      alt: 'Mochi overlay companion celebrating in dance pose',
      caption: 'Task completed celebration'
    },
    bonk: {
      src: './assets/screenshot-overlay-bonk.png',
      alt: 'Mochi overlay companion signaling window shifted and re-grounding',
      caption: 'Window shift re-grounding cue'
    }
  };

  var poseBtns = Array.prototype.slice.call(document.querySelectorAll('[data-pose]'));
  var poseImg = document.getElementById('pose-img');
  var poseCaption = document.getElementById('pose-caption');

  poseBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-pose');
      var pose = POSES[key];
      if (!pose) return;
      poseBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
      if (poseImg) {
        poseImg.src = pose.src;
        poseImg.alt = pose.alt;
      }
      if (poseCaption) poseCaption.textContent = pose.caption;
    });
  });

  // Act 6: Copy git clone command
  var copyBtn = document.getElementById('copy-clone');
  var copyStatus = document.getElementById('copy-status');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var cmd = copyBtn.getAttribute('data-copy') || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(function () {
          if (copyStatus) copyStatus.textContent = 'Copied command to clipboard.';
        }).catch(function () {
          if (copyStatus) copyStatus.textContent = 'Select the command above and press Ctrl + C.';
        });
      } else if (copyStatus) {
        copyStatus.textContent = 'Select the command above and press Ctrl + C.';
      }
    });
  }
})();
