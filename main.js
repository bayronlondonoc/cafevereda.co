(function () {
  "use strict";

  var data = window.__BRAND__ || {};
  var shopify = data.shopify || {};
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var escHTML = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function safe(fn, name) { try { fn(); } catch (e) { console.warn("[" + name + "]", e); } }

  var fmtCOP = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
  function money(a) { return fmtCOP.format(Math.round(parseFloat(a || 0))); }

  /* ---------------- Shopify Storefront ---------------- */
  function sfQuery(query, variables) {
    if (!shopify.domain || !shopify.token) return Promise.reject(new Error("Shopify no configurado"));
    return fetch("https://" + shopify.domain + "/api/" + shopify.apiVersion + "/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": shopify.token },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
      return j.data;
    });
  }

  var CART_FIELDS = "id checkoutUrl totalQuantity cost { subtotalAmount { amount currencyCode } } " +
    "lines(first: 25) { edges { node { id quantity merchandise { ... on ProductVariant { id title " +
    "price { amount } product { title featuredImage { url(transform: {maxWidth: 128, maxHeight: 128}) } } } } } } }";

  var state = { cart: null, variants: [], activeVariant: null, qty: 1 };
  var CART_KEY = "vereda_cart_id";

  /* ---------------- Producto ---------------- */
  function initShop() {
    var pills = $("[data-variant-pills]");
    var priceEl = $("[data-product-price]");
    if (!pills) return;
    sfQuery("{ products(first: 1) { edges { node { variants(first: 10) { edges { node { id title availableForSale price { amount } } } } } } } }")
      .then(function (d) {
        var edges = d && d.products && d.products.edges;
        if (!edges || !edges.length) return;
        state.variants = edges[0].node.variants.edges.map(function (e) {
          return { id: e.node.id, title: e.node.title, available: e.node.availableForSale, price: e.node.price.amount };
        });
        if (!state.variants.length) return;
        pills.innerHTML = state.variants.map(function (v, i) {
          return '<button class="pill' + (i === 0 ? " on" : "") + '" type="button" data-variant-id="' + escHTML(v.id) + '"' +
            (v.available ? "" : " disabled") + ">" + escHTML(v.title) + (v.available ? "" : " · agotado") + "</button>";
        }).join("");
        state.activeVariant = state.variants[0];
        if (priceEl) priceEl.textContent = money(state.activeVariant.price);
        $$(".pill", pills).forEach(function (btn) {
          btn.addEventListener("click", function () {
            if (btn.disabled) return;
            $$(".pill", pills).forEach(function (b) { b.classList.remove("on"); });
            btn.classList.add("on");
            state.activeVariant = state.variants.filter(function (v) { return v.id === btn.getAttribute("data-variant-id"); })[0] || null;
            if (priceEl && state.activeVariant) priceEl.textContent = money(state.activeVariant.price);
          });
        });
      })
      .catch(function (e) { console.warn("[shop]", e); });
  }

  function initQty() {
    var box = $("[data-qty]"); if (!box) return;
    var val = $("[data-qty-value]", box);
    $("[data-qty-minus]", box).addEventListener("click", function () { state.qty = Math.max(1, state.qty - 1); val.textContent = state.qty; });
    $("[data-qty-plus]", box).addEventListener("click", function () { state.qty = Math.min(20, state.qty + 1); val.textContent = state.qty; });
  }

  /* ---------------- Carrito ---------------- */
  function loadCart() {
    var id = null; try { id = localStorage.getItem(CART_KEY); } catch (_) {}
    if (!id) return;
    sfQuery("query($id: ID!) { cart(id: $id) { " + CART_FIELDS + " } }", { id: id })
      .then(function (d) {
        if (!d.cart) { try { localStorage.removeItem(CART_KEY); } catch (_) {} return; }
        state.cart = d.cart; renderCart();
      }).catch(function () {});
  }
  function ensureCart() {
    if (state.cart) return Promise.resolve(state.cart);
    return sfQuery("mutation { cartCreate(input: {}) { cart { " + CART_FIELDS + " } userErrors { message } } }")
      .then(function (d) { var c = d.cartCreate.cart; state.cart = c; try { localStorage.setItem(CART_KEY, c.id); } catch (_) {} return c; });
  }
  function addToCart(variantId, qty) {
    return ensureCart().then(function (c) {
      return sfQuery("mutation($cartId: ID!, $lines: [CartLineInput!]!) { cartLinesAdd(cartId: $cartId, lines: $lines) { cart { " + CART_FIELDS + " } userErrors { message } } }",
        { cartId: c.id, lines: [{ merchandiseId: variantId, quantity: qty }] });
    }).then(function (d) {
      var e = d.cartLinesAdd.userErrors; if (e && e.length) throw new Error(e[0].message);
      state.cart = d.cartLinesAdd.cart; renderCart();
    });
  }
  function updateLine(lineId, qty) {
    var m = qty > 0
      ? "mutation($cartId: ID!, $lines: [CartLineUpdateInput!]!) { cartLinesUpdate(cartId: $cartId, lines: $lines) { cart { " + CART_FIELDS + " } userErrors { message } } }"
      : "mutation($cartId: ID!, $lineIds: [ID!]!) { cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { " + CART_FIELDS + " } userErrors { message } } }";
    var v = qty > 0 ? { cartId: state.cart.id, lines: [{ id: lineId, quantity: qty }] } : { cartId: state.cart.id, lineIds: [lineId] };
    return sfQuery(m, v).then(function (d) { state.cart = (qty > 0 ? d.cartLinesUpdate : d.cartLinesRemove).cart; renderCart(); });
  }
  function renderCart() {
    var box = $("[data-cart-lines]"), foot = $("[data-cart-foot]"), sub = $("[data-cart-subtotal]"), count = $("[data-cart-count]");
    if (!box) return;
    var cart = state.cart, lines = cart ? cart.lines.edges : [];
    if (count) { var t = cart ? cart.totalQuantity : 0; count.textContent = t; count.hidden = t === 0; }
    if (!lines.length) {
      box.innerHTML = '<p class="cart-empty">Tu carrito está en calma.<br /><a href="#cafe" data-cart-close-link>Conoce el café →</a></p>';
      if (foot) foot.hidden = true; bindCloseLinks(); return;
    }
    box.innerHTML = lines.map(function (e) {
      var n = e.node, img = n.merchandise.product.featuredImage ? n.merchandise.product.featuredImage.url : "";
      var vt = n.merchandise.title === "Default Title" ? "" : n.merchandise.title;
      return '<div class="cart-line" data-line-id="' + escHTML(n.id) + '">' +
        (img ? '<img src="' + escHTML(img) + '" alt="" loading="lazy" />' : "<span></span>") +
        '<div><p class="cart-line-name">' + escHTML(n.merchandise.product.title) + "</p>" +
        (vt ? '<p class="cart-line-variant">' + escHTML(vt) + " · 340 g</p>" : "") +
        '<div class="cart-line-qty"><button type="button" data-line-minus aria-label="Reducir">−</button><span>' + n.quantity +
        '</span><button type="button" data-line-plus aria-label="Aumentar">+</button></div></div>' +
        '<div style="text-align:right"><p class="cart-line-price">' + money(parseFloat(n.merchandise.price.amount) * n.quantity) +
        '</p><button class="cart-line-remove" type="button" data-line-remove>Quitar</button></div></div>';
    }).join("");
    if (foot) foot.hidden = false;
    if (sub && cart.cost) sub.textContent = money(cart.cost.subtotalAmount.amount);
    $$(".cart-line", box).forEach(function (row) {
      var id = row.getAttribute("data-line-id");
      var line = lines.filter(function (e) { return e.node.id === id; })[0]; if (!line) return;
      $("[data-line-minus]", row).addEventListener("click", function () { updateLine(id, line.node.quantity - 1); });
      $("[data-line-plus]", row).addEventListener("click", function () { updateLine(id, line.node.quantity + 1); });
      $("[data-line-remove]", row).addEventListener("click", function () { updateLine(id, 0); });
    });
  }
  function bindCloseLinks() {
    $$("[data-cart-close-link]").forEach(function (a) { if (a.dataset.b) return; a.dataset.b = "1"; a.addEventListener("click", closeCart); });
  }
  function openCart() {
    var c = $("[data-cart]"), o = $("[data-cart-overlay]"); if (!c) return;
    c.hidden = false; o.hidden = false; void c.offsetWidth;
    c.classList.add("is-open"); o.classList.add("is-open"); document.body.style.overflow = "hidden";
  }
  function closeCart() {
    var c = $("[data-cart]"), o = $("[data-cart-overlay]"); if (!c) return;
    c.classList.remove("is-open"); o.classList.remove("is-open"); document.body.style.overflow = "";
    setTimeout(function () { c.hidden = true; o.hidden = true; }, 500);
  }
  function initCart() {
    var open = $("[data-cart-open]"), close = $("[data-cart-close]"), ov = $("[data-cart-overlay]");
    var add = $("[data-add-to-cart]"), checkout = $("[data-checkout]"), fb = $("[data-product-feedback]");
    if (open) open.addEventListener("click", openCart);
    if (close) close.addEventListener("click", closeCart);
    if (ov) ov.addEventListener("click", closeCart);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeCart(); });
    bindCloseLinks();
    if (add) add.addEventListener("click", function () {
      if (!state.activeVariant) { if (fb) fb.textContent = "Conectando con la tienda… intenta de nuevo en unos segundos."; initShop(); return; }
      add.disabled = true; var label = add.childNodes[0]; var prev = label.textContent; label.textContent = "Añadiendo… ";
      addToCart(state.activeVariant.id, state.qty).then(function () {
        label.textContent = prev; add.disabled = false; if (fb) fb.textContent = ""; openCart();
      }).catch(function (e) { label.textContent = prev; add.disabled = false; if (fb) fb.textContent = "No pudimos añadirlo: " + e.message; });
    });
    if (checkout) checkout.addEventListener("click", function () { if (state.cart && state.cart.checkoutUrl) window.location.href = state.cart.checkoutUrl; });
    loadCart();
  }

  /* ---------------- Newsletter (marcador de posición) ---------------- */
  function initNews() {
    var form = $("[data-news]"); if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("[data-news-msg]");
      if (msg) msg.textContent = "¡Gracias! Pronto conectamos el boletín para escribirte de verdad.";
    });
  }

  /* ---------------- UI ---------------- */
  function initNav() {
    var nav = $("[data-nav]"); if (!nav) return;
    var on = function () { nav.classList.toggle("is-solid", window.scrollY > 40); };
    on(); window.addEventListener("scroll", on, { passive: true });
  }
  function initMenu() {
    var nav = $("[data-nav]"), t = $("[data-menu-toggle]"); if (!nav || !t) return;
    t.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      t.setAttribute("aria-expanded", open ? "true" : "false");
      t.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
    });
    $$(".nav-links a", nav).forEach(function (a) {
      a.addEventListener("click", function () {
        nav.classList.remove("is-open"); t.setAttribute("aria-expanded", "false");
      });
    });
  }
  function initReveals() {
    var t = $$(".rv"); if (!t.length) return;
    if (!("IntersectionObserver" in window)) { t.forEach(function (e) { e.classList.add("in"); }); return; }
    var io = new IntersectionObserver(function (en) {
      en.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.08, rootMargin: "0px 0px -5% 0px" });
    t.forEach(function (e) { io.observe(e); });
    setTimeout(function () { $$(".rv:not(.in)").forEach(function (e) { if (e.getBoundingClientRect().top < innerHeight) e.classList.add("in"); }); }, 6000);
  }
  function initAnchors() {
    document.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest('a[href^="#"]') : null; if (!a) return;
      var id = a.getAttribute("href"); if (!id || id === "#") return;
      var el = document.querySelector(id); if (!el) return;
      e.preventDefault();
      window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 76, behavior: reduced ? "auto" : "smooth" });
    });
  }
  function initYear() { var y = $("[data-year]"); if (y) y.textContent = new Date().getFullYear(); }

  function boot() {
    safe(initNav, "initNav"); safe(initMenu, "initMenu"); safe(initReveals, "initReveals"); safe(initAnchors, "initAnchors");
    safe(initYear, "initYear"); safe(initQty, "initQty"); safe(initShop, "initShop");
    safe(initCart, "initCart"); safe(initNews, "initNews");
    document.documentElement.classList.add("is-ready");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
