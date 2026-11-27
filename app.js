"use strict";

/* ============================================================
 * VORTEX_HUB
 * THREE-IMPLEMENTATION RUNTIME
 *
 * 01. MANIFEST IMPLEMENTATION
 * 02. RESOLVER IMPLEMENTATION
 * 03. GATEWAY IMPLEMENTATION
 *
 * FLOW:
 * UI -> GATEWAY -> MANIFEST -> RESOLVER
 * RESOLVER -> VERIFIED ARTIFACT -> GATEWAY -> UI
 * ============================================================ */


/* ============================================================
 * 01. MANIFEST IMPLEMENTATION
 * ============================================================ */

const VORTEX_MANIFEST = (() => {
  const CONFIG = Object.freeze({
    identity: "VORTEX_HUB",
    version: "1.0.0",
    runtime: "javascript",
    target: "browser",
    source: "./index.html",
    mount: "#vortex-runtime-mount",
    template: 'template[data-vortex-template="registry"]',
    root: '[data-vortex-root="registry"]',
    cache: "vortex-hub-html-registry-v1",
    timeout: 15000,
    actions: Object.freeze([
      "validate",
      "registry"
    ])
  });

  const state = {
    status: "idle",
    request: 0,
    version: null,
    hash: null,
    source: null,
    lastVerified: null
  };

  function snapshot() {
    return Object.freeze({
      identity: CONFIG.identity,
      version: CONFIG.version,
      runtime: CONFIG.runtime,
      target: CONFIG.target,
      source: CONFIG.source,
      mount: CONFIG.mount,
      template: CONFIG.template,
      root: CONFIG.root,
      cache: CONFIG.cache,
      timeout: CONFIG.timeout,
      actions: CONFIG.actions,
      state: Object.freeze({ ...state })
    });
  }

  function update(values) {
    Object.assign(state, values);
    return snapshot();
  }

  return Object.freeze({
    CONFIG,
    snapshot,
    update
  });
})();


/* ============================================================
 * 02. RESOLVER IMPLEMENTATION
 * ============================================================ */

const VORTEX_RESOLVER = (() => {
  const CONFIG = VORTEX_MANIFEST.CONFIG;

  const state = {
    references: new Map(),
    components: new Map(),
    values: new Map()
  };

  const events = new EventTarget();

  const emit = (name, detail = {}) => {
    events.dispatchEvent(
      new CustomEvent(name, { detail })
    );
  };

  async function digest(content) {
    if (!crypto.subtle) {
      throw new Error("SHA-256 verification unavailable.");
    }

    const bytes = new TextEncoder().encode(content);
    const result = await crypto.subtle.digest("SHA-256", bytes);

    return Array.from(new Uint8Array(result))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function readCache() {
    if (!("caches" in window)) return null;

    const cache = await caches.open(CONFIG.cache);
    const response = await cache.match(
      new URL(CONFIG.source, location.href).href
    );

    if (!response) return null;

    const html = await response.text();
    const hash = await digest(html);

    return {
      html,
      hash,
      source: "cache"
    };
  }

  async function writeCache(source) {
    if (!("caches" in window)) return false;

    const cache = await caches.open(CONFIG.cache);

    const response = new Response(source.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Vortex-Hash": source.hash,
        "X-Vortex-Source": "verified-manifest"
      }
    });

    await cache.put(
      new URL(CONFIG.source, location.href).href,
      response
    );

    return true;
  }

  async function fetchSource() {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.timeout
    );

    try {
      const response = await fetch(
        new URL(CONFIG.source, location.href).href,
        {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "Accept": "text/html"
          }
        }
      );

      if (!response.ok) {
        throw new Error(
          "Source HTTP " + response.status
        );
      }

      const contentType =
        response.headers.get("content-type") || "";

      if (!contentType.includes("text/html")) {
        throw new Error("Invalid HTML content type.");
      }

      const html = await response.text();

      if (!html.trim()) {
        throw new Error("Empty HTML source.");
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

  function parse(source) {
    const documentSource = new DOMParser().parseFromString(
      source.html,
      "text/html"
    );

    const template = documentSource.querySelector(
      CONFIG.template
    );

    if (!template) {
      throw new Error("Manifest template not found.");
    }

    const root = template.content.querySelector(
      CONFIG.root
    );

    if (!root) {
      throw new Error("Manifest root not found.");
    }

    return {
      document: documentSource,
      template,
      root
    };
  }

  function verify(parsed) {
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
        throw new Error("Empty element reference.");
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
        throw new Error("Invalid component identity.");
      }

      componentMap.set(identity, component);
    }

    if (!inputs.length && !outputs.length) {
      throw new Error("No input/output references.");
    }

    const allowed = new Set(CONFIG.actions);

    for (const element of root.querySelectorAll(
      "[data-vortex-action]"
    )) {
      const action = element.dataset.vortexAction;

      if (!allowed.has(action)) {
        throw new Error("Unsupported action: " + action);
      }
    }

    return {
      references,
      components: componentMap,
      inputs,
      outputs
    };
  }

  function synchronizeStyles(sourceDocument) {
    document.querySelectorAll(
      "[data-vortex-runtime-style]"
    ).forEach(style => style.remove());

    for (const original of sourceDocument.querySelectorAll("style")) {
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

      state.references.set(
        "input:" + reference,
        input
      );

      state.values.set(
        reference,
        input.value || input.textContent || ""
      );

      input.addEventListener("input", () => {
        const value = input.value;

        state.values.set(reference, value);

        updateOutputs(reference, value);

        emit("vortex:input", {
          reference,
          value
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

  function bindActions(root, metadata) {
    root.addEventListener("click", event => {
      const button = event.target.closest(
        "[data-vortex-action]"
      );

      if (!button || !root.contains(button)) return;

      emit("vortex:action", {
        action: button.dataset.vortexAction,
        values: Object.fromEntries(state.values),
        version: metadata.version,
        hash: metadata.hash
      });
    });
  }

  function render(parsed, verified, metadata) {
    const mount = document.querySelector(CONFIG.mount);

    if (!mount) {
      throw new Error("Runtime mount not found.");
    }

    const fragment = document.importNode(
      parsed.root,
      true
    );

    mount.replaceChildren(fragment);

    state.references = verified.references;

    state.components = new Map(
      [...verified.components].map(([identity, component]) => [
        identity,
        component
      ])
    );

    bindReferences(mount);
    bindActions(mount, metadata);

    emit("vortex:rendered", {
      version: metadata.version,
      hash: metadata.hash,
      components: [...state.components.keys()]
    });
  }

  async function resolve(source) {
    const parsed = parse(source);
    const verified = verify(parsed);

    const manifest = VORTEX_MANIFEST.snapshot();

    const metadata = {
      version:
        parsed.template.dataset.version ||
        manifest.version,
      hash: source.hash,
      source: source.source
    };

    const previousHash = manifest.state.hash;

    synchronizeStyles(parsed.document);

    render(parsed, verified, metadata);

    VORTEX_MANIFEST.update({
      status: "verified",
      version: metadata.version,
      hash: metadata.hash,
      source: metadata.source,
      lastVerified: new Date().toISOString()
    });

    const status =
      previousHash === source.hash
        ? "unchanged"
        : "updated";

    emit("vortex:verified", {
      status,
      ...metadata
    });

    return status;
  }

  async function execute() {
    const requestId =
      VORTEX_MANIFEST.snapshot().state.request + 1;

    VORTEX_MANIFEST.update({
      request: requestId,
      status: "loading"
    });

    emit("vortex:loading");

    let networkError = null;

    try {
      const source = await fetchSource();

      if (
        requestId !==
        VORTEX_MANIFEST.snapshot().state.request
      ) {
        return;
      }

      const result = await resolve(source);

      await writeCache(source);

      if (
        requestId !==
        VORTEX_MANIFEST.snapshot().state.request
      ) {
        return;
      }

      return {
        result,
        source: "network",
        version: VORTEX_MANIFEST.snapshot().state.version
      };

    } catch (error) {
      networkError = error;
    }

    try {
      const cached = await readCache();

      if (!cached) throw networkError;

      if (
        requestId !==
        VORTEX_MANIFEST.snapshot().state.request
      ) {
        return;
      }

      const result = await resolve(cached);

      VORTEX_MANIFEST.update({
        status: "offline-cache"
      });

      return {
        result,
        source: "cache",
        version: VORTEX_MANIFEST.snapshot().state.version,
        warning: networkError?.message
      };

    } catch (error) {
      VORTEX_MANIFEST.update({
        status: "failed"
      });

      emit("vortex:error", {
        network: networkError?.message,
        cache: error?.message
      });

      throw error;
    }
  }

  function getState() {
    return {
      ...VORTEX_MANIFEST.snapshot().state,
      values: Object.fromEntries(state.values)
    };
  }

  return Object.freeze({
    execute,
    getState,
    events,
    updateOutputs
  });
})();


/* ============================================================
 * 03. GATEWAY IMPLEMENTATION
 * ============================================================ */

const VORTEX_GATEWAY = (() => {
  const events = new EventTarget();

  const emit = (name, detail = {}) => {
    events.dispatchEvent(
      new CustomEvent(name, { detail })
    );
  };

  async function request(intent = "registry") {
    if (!VORTEX_MANIFEST.CONFIG.actions.includes(intent)) {
      throw new Error("Unsupported gateway intent: " + intent);
    }

    emit("vortex:request", {
      intent,
      manifest: VORTEX_MANIFEST.snapshot()
    });

    const result = await VORTEX_RESOLVER.execute();

    const response = Object.freeze({
      identity: VORTEX_MANIFEST.CONFIG.identity,
      intent,
      result,
      state: VORTEX_RESOLVER.getState()
    });

    emit("vortex:response", response);

    return response;
  }

  function getState() {
    return VORTEX_RESOLVER.getState();
  }

  return Object.freeze({
    request,
    getState,
    events
  });
})();


/* ============================================================
 * RUNTIME EVENT CONTRACT
 * ============================================================ */

VORTEX_RESOLVER.events.addEventListener(
  "vortex:loading",
  event => {
    VORTEX_GATEWAY.events.dispatchEvent(
      new CustomEvent("vortex:loading", {
        detail: event.detail
      })
    );
  }
);

VORTEX_RESOLVER.events.addEventListener(
  "vortex:rendered",
  event => {
    VORTEX_GATEWAY.events.dispatchEvent(
      new CustomEvent("vortex:rendered", {
        detail: event.detail
      })
    );
  }
);

VORTEX_RESOLVER.events.addEventListener(
  "vortex:verified",
  event => {
    VORTEX_GATEWAY.events.dispatchEvent(
      new CustomEvent("vortex:verified", {
        detail: event.detail
      })
    );
  }
);

VORTEX_RESOLVER.events.addEventListener(
  "vortex:input",
  event => {
    VORTEX_GATEWAY.events.dispatchEvent(
      new CustomEvent("vortex:input", {
        detail: event.detail
      })
    );
  }
);

VORTEX_RESOLVER.events.addEventListener(
  "vortex:action",
  event => {
    const { action, values } = event.detail;

    if (action === "validate") {
      console.info("VALIDATE REQUEST", values);
    }

    if (action === "registry") {
      console.info("REGISTRY REQUEST", values);
    }

    VORTEX_GATEWAY.events.dispatchEvent(
      new CustomEvent("vortex:action", {
        detail: event.detail
      })
    );
  }
);

VORTEX_RESOLVER.events.addEventListener(
  "vortex:error",
  event => {
    VORTEX_GATEWAY.events.dispatchEvent(
      new CustomEvent("vortex:error", {
        detail: event.detail
      })
    );
  }
);


/* ============================================================
 * PUBLIC BINARY / UI GATEWAY
 * ============================================================ */

window.VORTEX_HUB = Object.freeze({
  manifest: VORTEX_MANIFEST,
  resolver: VORTEX_RESOLVER,
  gateway: VORTEX_GATEWAY,

  request: VORTEX_GATEWAY.request,
  getState: VORTEX_GATEWAY.getState,

  events: VORTEX_GATEWAY.events
});


/* ============================================================
 * RUNTIME ENTRY
 * ============================================================ */

VORTEX_GATEWAY.request("registry").catch(error => {
  console.error("VORTEX_HUB RUNTIME ERROR", error);
});
