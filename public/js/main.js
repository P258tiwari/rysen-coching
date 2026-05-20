/* RYSEN Coaching — Main JavaScript */

const nav = document.getElementById('site-nav');

// ─── Transparent nav for full-bleed hero pages ─────────────────────────────
const heroSection = document.querySelector('[data-hero-fullbleed]');

if (heroSection && nav) {
  nav.classList.add('nav-transparent');

  const heroObserver = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) {
        nav.classList.add('nav-transparent');
        nav.classList.remove('scrolled');
        nav.style.backgroundColor = '';
      } else {
        nav.classList.remove('nav-transparent');
        nav.classList.add('scrolled');
      }
    },
    { threshold: 0.05 }
  );
  heroObserver.observe(heroSection);
} else if (nav) {
  // Non-hero pages: always show solid nav
  nav.classList.add('scrolled');
}

// ─── Sticky nav shadow on non-hero pages ──────────────────────────────────
if (!heroSection && nav) {
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;';
  document.body.prepend(sentinel);

  new IntersectionObserver(
    ([entry]) => nav.classList.toggle('scrolled', !entry.isIntersecting),
    { threshold: 0 }
  ).observe(sentinel);
}

// ─── Scroll-triggered fade-in animations ──────────────────────────────────
const fadeObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        fadeObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
);

document.querySelectorAll('.fade-in').forEach((el) => fadeObserver.observe(el));

// ─── Mobile hamburger menu ─────────────────────────────────────────────────
const menuBtn = document.getElementById('mobile-menu-btn');
const mobileMenu = document.getElementById('mobile-menu');

if (menuBtn && mobileMenu) {
  menuBtn.addEventListener('click', () => {
    const isOpen = mobileMenu.classList.contains('open');
    if (isOpen) {
      mobileMenu.classList.remove('open');
      mobileMenu.classList.add('hidden');
      menuBtn.classList.remove('active');
      menuBtn.setAttribute('aria-expanded', 'false');
    } else {
      mobileMenu.classList.remove('hidden');
      mobileMenu.getBoundingClientRect();
      mobileMenu.classList.add('open');
      menuBtn.classList.add('active');
      menuBtn.setAttribute('aria-expanded', 'true');
    }
  });

  document.addEventListener('click', (e) => {
    if (!nav.contains(e.target) && mobileMenu.classList.contains('open')) {
      mobileMenu.classList.remove('open');
      mobileMenu.classList.add('hidden');
      menuBtn.classList.remove('active');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mobileMenu.classList.contains('open')) {
      mobileMenu.classList.remove('open');
      mobileMenu.classList.add('hidden');
      menuBtn.classList.remove('active');
      menuBtn.focus();
    }
  });
}
