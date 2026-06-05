/* ============================================================
   Konvico landing — interactions
   Vanilla JS, no dependencies. Progressive enhancement:
   everything degrades gracefully when JS is off.
   ============================================================ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── sticky nav shadow ──────────────────────────────── */
  var nav = document.getElementById('nav');
  function onScroll() {
    if (!nav) return;
    nav.classList.toggle('is-stuck', window.scrollY > 12);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ── mobile menu ────────────────────────────────────── */
  var burger = document.getElementById('burger');
  var mobileMenu = document.getElementById('mobileMenu');
  if (burger && mobileMenu) {
    burger.addEventListener('click', function () {
      var open = burger.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', String(open));
      mobileMenu.hidden = !open;
    });
    // close after picking a link
    mobileMenu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        burger.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
        mobileMenu.hidden = true;
      });
    });
  }

  /* ── reveal-on-scroll ───────────────────────────────── */
  var revealEls = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ── feature-card cursor glow ───────────────────────── */
  document.querySelectorAll('.card').forEach(function (card) {
    card.addEventListener('pointermove', function (e) {
      var r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });

  /* ── animated count-up for stats ────────────────────── */
  function animateCount(el) {
    var target = parseFloat(el.getAttribute('data-count'));
    if (isNaN(target)) return;
    var prefix = el.getAttribute('data-prefix') || '';
    var suffix = el.getAttribute('data-suffix') || '';
    function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
    if (reduceMotion) { el.innerHTML = prefix + fmt(target) + suffix; return; }
    var start = performance.now();
    var dur = 1300;
    function tick(now) {
      var p = Math.min((now - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);          // easeOutCubic
      el.innerHTML = prefix + fmt(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  var statNums = document.querySelectorAll('.stat__num[data-count]');
  if ('IntersectionObserver' in window && !reduceMotion) {
    var statIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { animateCount(entry.target); statIO.unobserve(entry.target); }
      });
    }, { threshold: 0.6 });
    statNums.forEach(function (el) { statIO.observe(el); });
  }

  /* ── hero chat typing sequence ──────────────────────── */
  var chatBody = document.getElementById('chatBody');
  var typing = document.getElementById('typing');
  if (chatBody) {
    var bubbles = Array.prototype.slice.call(chatBody.querySelectorAll('.bubble'));

    if (reduceMotion) {
      // show everything at once, no typing dots
      bubbles.forEach(function (b) { b.style.opacity = 1; b.style.transform = 'none'; });
    } else {
      // hide bubbles, then play them in order
      bubbles.forEach(function (b) { b.style.display = 'none'; });

      var i = 0;
      function showTyping(on) { if (typing) typing.classList.toggle('show', on); }

      function next() {
        if (i >= bubbles.length) { showTyping(false); return; }
        var b = bubbles[i];
        var isOut = b.classList.contains('bubble--out');
        var thinkMs = isOut ? 900 : 380;

        if (isOut) showTyping(true);
        setTimeout(function () {
          showTyping(false);
          b.style.display = '';               // revert to CSS display → triggers bubbleIn
          chatBody.scrollTop = chatBody.scrollHeight;
          i++;
          setTimeout(next, isOut ? 520 : 680);
        }, thinkMs);
      }

      function play() { i = 0; bubbles.forEach(function (b) { b.style.display = 'none'; }); setTimeout(next, 500); }

      // kick off when the phone scrolls into view (once)
      if ('IntersectionObserver' in window) {
        var chatIO = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) { play(); chatIO.unobserve(entry.target); }
          });
        }, { threshold: 0.4 });
        chatIO.observe(chatBody);
      } else {
        play();
      }
    }
  }

  /* ── footer year (future-proof) ─────────────────────── */
  var yearEl = document.querySelector('[data-year]');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
