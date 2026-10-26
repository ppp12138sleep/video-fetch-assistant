(() => {
  "use strict";

  const root = document.documentElement;
  root.classList.remove("no-js");
  root.classList.add("js");

  const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const prefersReducedMotion = () => reduceMotionQuery.matches;

  const header = document.getElementById("site-header");
  const nav = document.getElementById("primary-nav");
  const navToggle = document.getElementById("nav-toggle");
  const navSectionLinks = nav
    ? Array.from(nav.querySelectorAll("ul a[href^='#']"))
    : [];

  let menuOpen = false;

  /* ---------------------------------------------------------
     Mobile navigation
     --------------------------------------------------------- */

  function setMenu(open, options = {}) {
    if (!nav || !navToggle) return;

    menuOpen = open;
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
    nav.classList.toggle("is-open", open);
    document.body.classList.toggle("nav-open", open);

    if (!open && options.restoreFocus) {
      navToggle.focus();
    }
  }

  function focusFirstNavLink() {
    const firstLink = nav ? nav.querySelector("a[href^='#']") : null;
    if (firstLink) firstLink.focus();
  }

  if (navToggle) {
    navToggle.addEventListener("click", () => {
      const willOpen = !menuOpen;
      setMenu(willOpen);
      if (willOpen) {
        window.setTimeout(() => {
          if (menuOpen) focusFirstNavLink();
        }, 30);
      }
    });
  }

  document.addEventListener("click", (event) => {
    if (!menuOpen || !nav || !navToggle) return;
    if (nav.contains(event.target) || navToggle.contains(event.target)) return;

    const focusWasInMenu = nav.contains(document.activeElement);
    setMenu(false, { restoreFocus: focusWasInMenu });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menuOpen) {
      setMenu(false, { restoreFocus: true });
    }
  });

  const desktopQuery = window.matchMedia("(min-width: 961px)");
  const handleDesktopChange = (event) => {
    if (event.matches && menuOpen) setMenu(false);
  };

  if (typeof desktopQuery.addEventListener === "function") {
    desktopQuery.addEventListener("change", handleDesktopChange);
  } else if (typeof desktopQuery.addListener === "function") {
    desktopQuery.addListener(handleDesktopChange);
  }

  /* ---------------------------------------------------------
     Smooth anchor scrolling, scroll spy, sticky header
     --------------------------------------------------------- */

  const spyTargets = navSectionLinks
    .map((link) => {
      const href = link.getAttribute("href");
      const section = href ? document.querySelector(href) : null;
      return section ? { link, section } : null;
    })
    .filter(Boolean);

  let scrollTicking = false;

  function updateHeaderState() {
    if (header) {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    }
  }

  function updateActiveLink() {
    if (!spyTargets.length) return;

    const offset = (header ? header.offsetHeight : 72) + 90;
    let activeTarget = null;

    for (const target of spyTargets) {
      if (target.section.getBoundingClientRect().top <= offset) {
        activeTarget = target;
      }
    }

    const atPageBottom =
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 4;

    if (atPageBottom) {
      activeTarget = spyTargets[spyTargets.length - 1];
    }

    for (const target of spyTargets) {
      const isActive = activeTarget === target;
      target.link.classList.toggle("is-active", isActive);
      if (isActive) {
        target.link.setAttribute("aria-current", "location");
      } else {
        target.link.removeAttribute("aria-current");
      }
    }
  }

  function handleScroll() {
    if (scrollTicking) return;

    scrollTicking = true;
    window.requestAnimationFrame(() => {
      updateHeaderState();
      updateActiveLink();
      scrollTicking = false;
    });
  }

  window.addEventListener("scroll", handleScroll, { passive: true });
  window.addEventListener("resize", handleScroll);

  const internalLinks = Array.from(document.querySelectorAll("a[href^='#']"));

  internalLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      const href = link.getAttribute("href");
      if (!href || href === "#") return;

      let target = null;
      try {
        target = document.querySelector(href);
      } catch (error) {
        target = null;
      }

      if (!target) return;

      event.preventDefault();

      const menuWasOpen = menuOpen;
      if (menuWasOpen) setMenu(false);

      if (menuWasOpen || target.id === "main") {
        if (!target.hasAttribute("tabindex")) {
          target.setAttribute("tabindex", "-1");
        }
        target.focus({ preventScroll: true });
      }

      target.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });

      try {
        window.history.pushState(null, "", href);
      } catch (error) {
        /* file:// and sandboxed contexts may reject History API calls. */
      }
    });
  });

  updateHeaderState();
  updateActiveLink();

  /* ---------------------------------------------------------
     Reveal on scroll
     --------------------------------------------------------- */

  const revealElements = Array.from(document.querySelectorAll(".reveal"));

  function showAllRevealed() {
    for (const element of revealElements) {
      element.classList.add("is-visible");
    }
  }

  if (!("IntersectionObserver" in window) || prefersReducedMotion()) {
    showAllRevealed();
  } else {
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      },
      {
        rootMargin: "0px 0px -8% 0px",
        threshold: 0.06,
      }
    );

    for (const element of revealElements) {
      revealObserver.observe(element);
    }

    const handleMotionPreference = () => {
      if (!prefersReducedMotion()) return;
      revealObserver.disconnect();
      showAllRevealed();
    };

    if (typeof reduceMotionQuery.addEventListener === "function") {
      reduceMotionQuery.addEventListener("change", handleMotionPreference);
    } else if (typeof reduceMotionQuery.addListener === "function") {
      reduceMotionQuery.addListener(handleMotionPreference);
    }
  }

  /* ---------------------------------------------------------
     Screenshot lightbox
     --------------------------------------------------------- */

  const lightbox = document.getElementById("lightbox");
  const lightboxImage = document.getElementById("lightbox-image");
  const lightboxTitle = document.getElementById("lightbox-title");
  const lightboxCaption = document.getElementById("lightbox-caption-text");
  const lightboxClose = document.getElementById("lightbox-close");
  const shotTriggers = Array.from(document.querySelectorAll(".shot-trigger"));

  let lastLightboxTrigger = null;

  function closeLightbox() {
    if (!lightbox || !lightbox.open) return;
    if (typeof lightbox.close === "function") {
      lightbox.close();
    } else {
      lightbox.removeAttribute("open");
    }
  }

  if (lightbox && lightboxImage && lightboxTitle && lightboxCaption) {
    for (const trigger of shotTriggers) {
      trigger.addEventListener("click", () => {
        const image = trigger.querySelector("img");
        if (!image) return;

        lastLightboxTrigger = trigger;
        lightboxImage.src = trigger.dataset.full || image.currentSrc || image.src;
        lightboxImage.alt = image.alt || "";
        lightboxImage.width = Number(trigger.dataset.width) || image.naturalWidth || 1366;
        lightboxImage.height = Number(trigger.dataset.height) || image.naturalHeight || 852;
        lightboxTitle.textContent = trigger.dataset.title || "真实界面";
        lightboxCaption.textContent = trigger.dataset.caption || "";

        if (typeof lightbox.showModal === "function") {
          lightbox.showModal();
        } else {
          lightbox.setAttribute("open", "");
        }

        if (lightboxClose) lightboxClose.focus();
      });
    }

    lightbox.addEventListener("click", (event) => {
      if (event.target === lightbox) closeLightbox();
    });

    if (lightboxClose) {
      lightboxClose.addEventListener("click", closeLightbox);
    }

    /* The ::backdrop pseudo-element does not always receive a target in every
       browser, so also close when a click lands outside the dialog box. */
    document.addEventListener(
      "click",
      (event) => {
        if (!lightbox.open) return;

        const rect = lightbox.getBoundingClientRect();
        const isOutside =
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom;

        if (isOutside) closeLightbox();
      },
      true
    );

    lightbox.addEventListener("close", () => {
      if (lastLightboxTrigger) {
        lastLightboxTrigger.focus();
        lastLightboxTrigger = null;
      }
    });
  }

  /* ---------------------------------------------------------
     FAQ accordion
     --------------------------------------------------------- */

  const faqItems = Array.from(document.querySelectorAll(".faq-item"));

  for (const item of faqItems) {
    item.addEventListener("toggle", () => {
      if (!item.open) return;
      for (const other of faqItems) {
        if (other !== item && other.open) other.open = false;
      }
    });
  }

  /* ---------------------------------------------------------
     Copy to clipboard + toast
     --------------------------------------------------------- */

  const toast = document.getElementById("toast");
  let toastTimer = 0;

  function showToast(message, kind = "success") {
    if (!toast) return;

    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.classList.add("is-visible");

    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 2800);
  }

  function legacyCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }

    textarea.remove();
    return copied;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        /* Fall through to the selection-based copy fallback. */
      }
    }

    return legacyCopy(text);
  }

  function selectCommand(button) {
    const scope = button.closest(".code-block, .command-row");
    const command = scope ? scope.querySelector("code") : null;
    if (!command) return;

    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  const copyButtons = Array.from(document.querySelectorAll(".copy-btn"));

  for (const button of copyButtons) {
    button.addEventListener("click", async () => {
      if (button.dataset.busy === "true") return;

      const label = button.querySelector(".copy-label");
      const defaultLabel = label ? label.textContent : "";
      const text = button.dataset.copy || "";

      button.dataset.busy = "true";
      const copied = await copyText(text);

      if (copied) {
        if (label) label.textContent = "已复制";
        button.classList.add("is-copied");
        showToast("命令已复制到剪贴板");
      } else {
        selectCommand(button);
        showToast("复制失败，请手动选择命令复制。", "error");
      }

      window.setTimeout(() => {
        button.dataset.busy = "false";
        if (label) label.textContent = defaultLabel;
        button.classList.remove("is-copied");
      }, 1800);
    });
  }

  /* ---------------------------------------------------------
     Footer year
     --------------------------------------------------------- */

  const yearElement = document.getElementById("year");
  if (yearElement) {
    yearElement.textContent = String(new Date().getFullYear());
  }
})();
