
"use strict";

/*
 * VORTEX_HUB REGISTRY
 * HTML Runtime Loader
 *
 * Source of truth: index.html
 * Runtime: app.js
 */

const VORTEX = (() => {
  const CONFIG = Object.freeze({
    source: new URL("./index.html", location.href).href,
    mount: "#vortex-runtime-mount",
    template: 'template[data-vortex-template="registry"]',
    cacheName: "vortex-hub-html-registry-v1",
    cacheKey: new URL("./index.html", location.href).href,
    timeout: 15000
  });

  const state = {
    status: "idle",
    version: null,
    hash: null,
    source: null,
    lastVerified: null,
    references: new Map(),
    components: new Map(),
    values: new Map(),
    request: 0
  };

  const events = new EventTarget();

  const emit = (name, detail = {}) => {
    events.dispatchEvent(
      new CustomEvent(name, { detail })
    );
  };

  function resolveMount() {
    const mount = document.querySelector(CONFIG.mount);

    if (!mount) {
      throw new Error("Runtime mount point not found.");
    }

    return mount;
  }

  async function digest(content) {
    if (!crypto.subtle) {
      throw new Error("SHA-256 verification is unavailable.");
    }

    const bytes = new TextEncoder().encode(content);
    const result = await crypto.subtle.digest("SHA-256", bytes);

    return Array.from(new Uint8Array(result))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function readCache() {
    if (!("caches" in window)) return null;

    const cache = await caches.open(CONFIG.cacheName);
    const response = await cache.match(CONFIG.cacheKey);

    if (!response) return null;

    const html = await response.text();

    return {
      html,
      hash: await digest(html),
      source: "cache"
    };
  }

  async function writeCache(html, hash) {
    if (!("caches" in window)) return false;

    const cache = await caches.open(CONFIG.cacheName);

    const response = new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Vortex-Hash": hash,
        "X-Vortex-Source": "verified-index"
      }
    });

    await cache.put(CONFIG.cacheKey, response);
    return true;
  }

  async function fetchLatest() {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.timeout
    );

    try {
      const response = await fetch(CONFIG.source, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Accept": "text/html"
        }
      });

      if (!response.ok) {
        throw new Error("HTML source returned HTTP " + response.status);
      }

      const contentType =
        response.headers.get("content-type") || "";

      if (!contentType.includes("text/html")) {
        throw new Error("Source is not an HTML document.");
      }

      const html = await response.text();

      if (!html.trim()) {
        throw new Error("HTML source is empty.");
      }

      return {
        html,
        hash: await digest(html),
        source: "network"
      };

    } finally {
      clearTimeout(timeout);
    }
  }

  function parseSource(html) {
    const documentSource = new DOMParser().parseFromString(
      html,
      "text/html"
    );

    const template = documentSource.querySelector(
      CONFIG.template
    );

    if (!template) {
      throw new Error("Registry HTML template not found.");
    }

    const root = template.content.querySelector(
      '[data-vortex-root="registry"]'
    );

    if (!root) {
      throw new Error("Registry root reference not found.");
    }

    return {
      document: documentSource,
      template,
      root
    };
  }

  function verifySource(parsed) {
    const root = parsed.root;

    const inputs = [
      ...root.querySelectorAll("[data-vortex-role='input']")
    ];

    const outputs = [
      ...root.querySelectorAll("[data-vortex-role='output']")
    ];

    const components = [
      ...root.querySelectorAll("[data-vortex-component]")
    ];

    const references = new Map();
    const componentMap = new Map();

    for (const element of [...inputs, ...outputs]) {
      const reference = element.dataset.vortexRef;

      if (!reference) {
        throw new Error("An element has an empty reference.");
      }

      const role = element.dataset.vortexRole;
      const key = role + ":" + reference;

      if (!references.has(key)) {
        references.set(key, []);
      }

      references.get(key).push(element);
    }

    for (const [key, elements] of references) {
      if (elements.length > 1) {
        throw new Error("Duplicate reference: " + key);
      }
    }

    for (const component of components) {
      const identity = component.dataset.vortexComponent;

      if (!identity || componentMap.has(identity)) {
        throw new Error("Invalid or duplicate component identity.");
      }

      componentMap.set(identity, component);
    }

    if (!inputs.length && !outputs.length) {
      throw new Error("No input or output references found.");
    }

    return {
      references,
      components
    };
  }

  function verifyActions(root) {
    const allowed = new Set([
      "validate",
      "registry"
    ]);

    for (const button of root.querySelectorAll(
      "[data-vortex-action]"
    )) {
      const action = button.dataset.vortexAction;

      if (!allowed.has(action)) {
        throw new Error("Unsupported action: " + action);
      }
    }
  }

  function synchronizeStyles(sourceDocument) {
    const existing = document.querySelector(
      '[data-vortex-runtime-style]'
    );

    if (existing) existing.remove();

    const styles = sourceDocument.querySelectorAll("style");

    for (const original of styles) {
      const style = document.createElement("style");

      style.dataset.vortexRuntimeStyle = "true";
      style.textContent = original.textContent;

      document.head.append(style);
    }
  }

  function bindReferences(root) {
    state.references.clear();
    state.values.clear();

    const inputs = root.querySelectorAll(
      "[data-vortex-role='input']"
    );

    const outputs = root.querySelectorAll(
      "[data-vortex-role='output']"
    );

    for (const input of inputs) {
      const reference = input.dataset.vortexRef;

      state.references.set("input:" + reference, input);

      state.values.set(
        reference,
        input.value || input.textContent || ""
      );

      input.addEventListener("input", () => {
        state.values.set(reference, input.value);

        updateOutputs(reference, input.value);

        emit("vortex:input", {
          reference,
          value: input.value
        });
      });
    }

    for (const output of outputs) {
      const reference = output.dataset.vortexRef;

      const key = "output:" + reference;

      if (!state.references.has(key)) {
        state.references.set(key, []);
      }

      state.references.get(key).push(output);

      if (state.values.has(reference)) {
        output.textContent = state.values.get(reference);
      }
    }
  }

  function updateOutputs(reference, value) {
    const outputs = state.references.get(
      "output:" + reference
    ) || [];

    for (const output of outputs) {
      output.textContent = String(value ?? "");
    }
  }

  function bindActions(root) {
    root.addEventListener("click", event => {
      const button = event.target.closest(
        "[data-vortex-action]"
      );

      if (!button || !root.contains(button)) return;

      const action = button.dataset.vortexAction;

      emit("vortex:action", {
        action,
        values: Object.fromEntries(state.values),
        version: state.version,
        hash: state.hash
      });
    });
  }

  function render(parsed, verified) {
    const mount = resolveMount();

    const fragment = document.importNode(
      parsed.root,
      true
    );

    mount.replaceChildren(fragment);

    state.references = verified.references;
    state.components = new Map(
      verified.components.map(component => [
        component.dataset.vortexComponent,
        component
      ])
    );

    bindReferences(mount);
    bindActions(mount);

    emit("vortex:rendered", {
      version: state.version,
      hash: state.hash,
      components: [...state.components.keys()]
    });
  }

  async function processSource(source) {
    const parsed = parseSource(source.html);

    const verified = verifySource(parsed);

    verifyActions(parsed.root);

    const previousHash = state.hash;

    synchronizeStyles(parsed.document);

    state.hash = source.hash;
    state.version =
      parsed.template.dataset.version || "unversioned";

    state.source = source.source;
    state.lastVerified = new Date().toISOString();

    render(parsed, verified);

    state.status =
      previousHash === source.hash
        ? "unchanged"
        : "updated";

    emit("vortex:verified", {
      status: state.status,
      version: state.version,
      hash: state.hash,
      source: state.source
    });

    return state.status;
  }

  async function load() {
    const requestId = ++state.request;

    state.status = "loading";
    emit("vortex:loading");

    let networkError = null;

    try {
      const latest = await fetchLatest();

      if (requestId !== state.request) return;

      const result = await processSource(latest);

      await writeCache(latest.html, latest.hash);

      if (requestId !== state.request) return;

      emit("vortex:ready", {
        result,
        source: "network",
        version: state.version
      });

      return result;

    } catch (error) {
      networkError = error;
    }

    try {
      const cached = await readCache();

      if (!cached) throw networkError;

      if (requestId !== state.request) return;

      const result = await processSource(cached);

      state.status = "offline-cache";

      emit("vortex:ready", {
        result,
        source: "cache",
        version: state.version,
        warning: networkError?.message
      });

      return result;

    } catch (cacheError) {
      state.status = "failed";

      emit("vortex:error", {
        network: networkError?.message,
        cache: cacheError?.message
      });

      throw cacheError;
    }
  }

  function getState() {
    return {
      status: state.status,
      version: state.version,
      hash: state.hash,
      source: state.source,
      lastVerified: state.lastVerified,
      values: Object.fromEntries(state.values)
    };
  }

  return Object.freeze({
    load,
    getState,
    events,
    updateOutputs
  });
})();

/* Runtime lifecycle */

VORTEX.events.addEventListener("vortex:ready", event => {
  console.info("VORTEX_HUB READY", event.detail);
});

VORTEX.events.addEventListener("vortex:error", event => {
  console.error("VORTEX_HUB LOAD FAILED", event.detail);
});

VORTEX.events.addEventListener("vortex:action", event => {
  const { action, values } = event.detail;

  /*
   * Connect validated domain operations here.
   * This loader does not register domains or modify DNS.
   */

  if (action === "validate") {
    console.info("VALIDATE REQUEST", values);
  }

  if (action === "registry") {
    console.info("REGISTRY REQUEST", values);
  }
});

VORTEX.load().catch(error => {
  console.error("VORTEX_HUB RUNTIME ERROR", error);
});

/* Public runtime reference */

window.VORTEX_HUB = VORTEX;
