"use strict";

(function initSettingsTabMobile(root) {
  const MOBILE_INFO_RETRY_MS = 200;
  const MOBILE_INFO_MAX_RETRIES = 10;

  const HTTPS_POLL_MS = 800;
  const HTTPS_POLL_MAX = 30;

  let runtime = null;
  let helpers = null;
  let state = null;
  let v2Container = null;
  let httpsInfoContainer = null;
  let devicesContainer = null;
  let devicesTitleEl = null;
  let pushContainer = null;
  let qrContainer = null;
  let pairingCodeContainer = null;
  let qrVisible = false;
  let httpsPollTimer = null;
  let changeListenerRegistered = false;

  function t(key) {
    return helpers.t(key);
  }

  function escapeHtml(str) {
    return helpers.escapeHtml(str);
  }

  function snapshot() {
    return (state && state.snapshot) || {};
  }

  function mobileEnabled() {
    return snapshot().mobilePreviewEnabled === true;
  }

  function formatTimestamp(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
    try { return new Date(ms).toLocaleString(); } catch { return null; }
  }

  function fetchMobileInfo() {
    if (!window.settingsAPI || typeof window.settingsAPI.getMobileConnectionInfo !== "function") {
      return Promise.resolve(null);
    }
    return window.settingsAPI.getMobileConnectionInfo().catch(() => null);
  }

  function isReadyMobileInfo(info) {
    return !!(
      info
      && info.status === "ok"
      && Number.isInteger(info.port)
      && info.port > 0
      && typeof info.token === "string"
      && info.token
      && typeof info.lanIp === "string"
      && info.lanIp
    );
  }

  function renderConnectionInfo(container, attempt = 0) {
    container.innerHTML = "";
    const snapshot = (state && state.snapshot) || {};
    const enabled = snapshot.mobilePreviewEnabled === true;
    if (!enabled) {
      container.innerHTML = `<p class="mobile-info-loading">${escapeHtml(t("mobileDisabled") || "Enable the toggle above to start the LAN bridge.")}</p>`;
      return;
    }

    container.innerHTML = `<div class="mobile-info-loading">${escapeHtml(t("mobileLoading") || "Loading...")}</div>`;

    fetchMobileInfo().then((info) => {
      if (!container.parentNode) return;
      if (!isReadyMobileInfo(info)) {
        if (
          attempt < MOBILE_INFO_MAX_RETRIES
          && info
          && (info.status === "starting" || info.status === "ok")
        ) {
          setTimeout(() => {
            if (container.parentNode) renderConnectionInfo(container, attempt + 1);
          }, MOBILE_INFO_RETRY_MS);
          return;
        }
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobileError") || "Unable to load connection info.")}</p>`;
        return;
      }

      let html = '';

      // Connection details
      html += '<div class="mobile-conn-details">';
      html += `<div class="mobile-conn-row"><span class="mobile-conn-label">LAN IP</span><span class="mobile-conn-value">${escapeHtml(info.lanIp)}</span>`;
      html += `<button class="mobile-copy-btn" data-copy="${escapeHtml(info.lanIp)}">Copy</button></div>`;
      html += `<div class="mobile-conn-row"><span class="mobile-conn-label">Port</span><span class="mobile-conn-value">${info.port}</span>`;
      html += `<button class="mobile-copy-btn" data-copy="${String(info.port)}">Copy</button></div>`;
      html += `<div class="mobile-conn-row"><span class="mobile-conn-label">Token</span><span class="mobile-conn-value mobile-token">${escapeHtml(info.token)}</span>`;
      html += `<button class="mobile-copy-btn" data-copy="${escapeHtml(info.token)}">Copy</button></div>`;

      html += '</div>';

      // Action buttons
      html += '<div class="mobile-conn-actions">';
      html += `<button class="soft-btn accent" id="mobile-regenerate-btn">${escapeHtml(t("mobileRegenerate") || "Regenerate Token")}</button>`;
      html += `<button class="soft-btn danger" id="mobile-reset-btn">${escapeHtml(t("mobileReset") || "Reset Mobile Access")}</button>`;
      html += '</div>';

      container.innerHTML = html;

      // Copy button handlers
      container.querySelectorAll(".mobile-copy-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const text = btn.getAttribute("data-copy");
          if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
              btn.textContent = "Copied!";
              setTimeout(() => { btn.textContent = "Copy"; }, 1500);
            });
          }
        });
      });

      // Regenerate button handler
      var regenBtn = container.querySelector("#mobile-regenerate-btn");
      if (regenBtn) {
        regenBtn.addEventListener("click", function() {
          var confirmMsg = t("mobileRegenerateConfirm") || "Regenerate token? All connected devices will be disconnected and will need to re-pair.";
          if (!window.confirm(confirmMsg)) return;
          if (!window.settingsAPI || typeof window.settingsAPI.regenerateMobileToken !== "function") return;
          window.settingsAPI.regenerateMobileToken().then(function(result) {
            if (result && result.status === "ok") {
              renderConnectionInfo(container);
            }
          });
        });
      }

      // Reset button handler
      var resetBtn = container.querySelector("#mobile-reset-btn");
      if (resetBtn) {
        resetBtn.addEventListener("click", function() {
          var confirmMsg = t("mobileResetConfirm") || "Reset mobile access? All connected devices will be disconnected and a new token will be generated.";
          if (!window.confirm(confirmMsg)) return;
          if (!window.settingsAPI || typeof window.settingsAPI.resetMobileAccess !== "function") return;
          window.settingsAPI.resetMobileAccess().then(function(result) {
            if (result && result.status === "ok") {
              renderConnectionInfo(container);
            }
          });
        });
      }
    });
  }

  function buildConnectionModeRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"></div>`;
    row.querySelector(".row-label").textContent = t("mobileConnModeTitle");
    row.querySelector(".row-desc").textContent = t("mobileConnModeDesc");

    const select = document.createElement("select");
    select.className = "mobile-conn-mode-select";
    const modes = [
      { value: "lan", labelKey: "mobileConnModeLan" },
      { value: "tailscale", labelKey: "mobileConnModeTailscale" },
    ];
    const current = snapshot().mobileConnectionMode === "tailscale" ? "tailscale" : "lan";
    for (const m of modes) {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = t(m.labelKey);
      if (m.value === current) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      if (window.settingsAPI && typeof window.settingsAPI.update === "function") {
        window.settingsAPI.update("mobileConnectionMode", select.value);
      }
    });
    row.querySelector(".row-control").appendChild(select);
    return row;
  }

  // A fixed-port input. Editing it persists the pref (validated 1024-65535) which
  // restarts the listener main-side. iOS A2HS freezes its launch port, so a stable
  // port is what keeps a paired phone reconnecting after a desktop restart.
  function buildPortRow(prefKey, titleKey, descKey) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"></div>`;
    row.querySelector(".row-label").textContent = t(titleKey);
    row.querySelector(".row-desc").textContent = t(descKey);

    const input = document.createElement("input");
    input.type = "number";
    input.className = "mobile-port-input";
    input.min = "1024";
    input.max = "65535";
    input.step = "1";
    const current = snapshot()[prefKey];
    if (Number.isInteger(current)) input.value = String(current);

    const commit = () => {
      const val = parseInt(input.value, 10);
      input.classList.remove("mobile-port-invalid");
      if (!Number.isInteger(val) || val < 1024 || val > 65535) {
        input.classList.add("mobile-port-invalid");
        input.title = t("mobilePortInvalid");
        return;
      }
      input.title = "";
      if (val === snapshot()[prefKey]) return;
      if (window.settingsAPI && typeof window.settingsAPI.update === "function") {
        window.settingsAPI.update(prefKey, val);
        // The listener restart is debounced (~300ms) and a busy port retries for
        // ~3s before the failure is recorded, so re-check the bind result after it
        // settles rather than making the user leave and re-enter the tab.
        const errSlot = row.parentNode && row.parentNode.querySelector(".mobile-port-error");
        if (errSlot) {
          setTimeout(() => renderPortBindError(errSlot), 800);
          setTimeout(() => renderPortBindError(errSlot), 4000);
        }
      }
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });

    row.querySelector(".row-control").appendChild(input);
    return row;
  }

  // Surfaces an HTTP bind failure (e.g. the chosen port is occupied) under the
  // port inputs, so a silent "starting…" forever can't hide it.
  function renderPortBindError(container) {
    container.innerHTML = "";
    fetchMobileInfo().then((info) => {
      if (!container.parentNode || !info || info.status !== "error" || !info.lastError) return;
      container.innerHTML = `<p class="mobile-info-error">${escapeHtml(info.lastError)}</p>`;
    });
  }

  function stopHttpsPoll() {
    if (httpsPollTimer) { clearTimeout(httpsPollTimer); httpsPollTimer = null; }
  }

  function renderHttpsInfo(attempt = 0) {
    if (!httpsInfoContainer) return;
    const container = httpsInfoContainer;
    container.innerHTML = "";

    if (snapshot().mobileHttpsEnabled !== true) {
      stopHttpsPoll();
      return;
    }

    if (!window.settingsAPI || typeof window.settingsAPI.getMobileHttpsInfo !== "function") return;

    window.settingsAPI.getMobileHttpsInfo().then((info) => {
      if (!container.parentNode) return;
      if (!info || info.status !== "ok") {
        container.innerHTML = `<p class="mobile-info-loading">${escapeHtml(t("mobileHttpsStarting"))}</p>`;
        return;
      }
      if (!info.httpsReady) {
        if (info.lastError) {
          // A real failure (cert mint / port bind) — stop polling and say so,
          // instead of showing "setting up…" forever.
          stopHttpsPoll();
          container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobileHttpsError"))}: ${escapeHtml(info.lastError)}</p>`;
          return;
        }
        container.innerHTML = `<p class="mobile-info-loading">${escapeHtml(t("mobileHttpsStarting"))}</p>`;
        if (attempt < HTTPS_POLL_MAX) {
          stopHttpsPoll();
          httpsPollTimer = setTimeout(() => {
            if (container.parentNode) renderHttpsInfo(attempt + 1);
          }, HTTPS_POLL_MS);
        }
        return;
      }

      stopHttpsPoll();

      let html = `<div class="mobile-cert-section">`;
      html += `<div class="mobile-cert-title">${escapeHtml(t("mobileCertSection"))}</div>`;
      html += `<p class="mobile-cert-instructions">${escapeHtml(t("mobileCertInstructions"))}</p>`;
      html += `<div class="mobile-cert-download"></div>`;
      if (info.caFingerprint) {
        html += `<div class="mobile-conn-row"><span class="mobile-conn-label">${escapeHtml(t("mobileCertCaFingerprint"))}</span><span class="mobile-conn-value">${escapeHtml(info.caFingerprint)}</span></div>`;
      }
      if (info.leafFingerprint) {
        html += `<div class="mobile-conn-row"><span class="mobile-conn-label">${escapeHtml(t("mobileCertLeafFingerprint"))}</span><span class="mobile-conn-value">${escapeHtml(info.leafFingerprint)}</span></div>`;
      }
      html += `</div>`;
      container.innerHTML = html;

      const dlSlot = container.querySelector(".mobile-cert-download");
      if (dlSlot) {
        const a = document.createElement("a");
        a.className = "soft-btn accent";
        a.textContent = t("mobileCertDownload");
        // Open the CA over the plain-HTTP monitoring origin so the phone can
        // fetch it before it trusts anything. Build from the connection info.
        a.href = "#";
        a.addEventListener("click", (e) => {
          e.preventDefault();
          buildCaUrl().then((url) => {
            if (url && window.settingsAPI && typeof window.settingsAPI.openExternal === "function") {
              window.settingsAPI.openExternal(url);
            }
          });
        });
        dlSlot.appendChild(a);
      }

      const trustedRow = helpers.buildSwitchRow({
        key: "mobileCertTrustedHint",
        labelKey: "mobileCertTrustedToggle",
        descKey: "mobileCertTrustedDesc",
      });
      container.appendChild(trustedRow);
    }).catch(() => {});
  }

  function buildCaUrl() {
    if (!window.settingsAPI || typeof window.settingsAPI.getMobileConnectionInfo !== "function") {
      return Promise.resolve(null);
    }
    return window.settingsAPI.getMobileConnectionInfo().then((info) => {
      if (!info || info.status !== "ok" || !info.lanIp || !info.port) return null;
      return `http://${info.lanIp}:${info.port}/ca.crt`;
    }).catch(() => null);
  }

  function renderQr() {
    if (!qrContainer) return;
    const container = qrContainer;
    if (!qrVisible) { container.innerHTML = ""; return; }
    container.innerHTML = `<p class="mobile-info-loading">${escapeHtml(t("mobilePairLoadingQr"))}</p>`;

    if (!window.settingsAPI || typeof window.settingsAPI.getMobilePairingQr !== "function") return;
    window.settingsAPI.getMobilePairingQr().then((res) => {
      if (!container.parentNode) return;
      if (!res || res.status !== "ok") {
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobilePairQrError"))}</p>`;
        return;
      }
      let html = `<div class="mobile-qr-grid">`;
      if (res.host) {
        html += `<div class="mobile-qr-card">`;
        html += `<div class="mobile-qr-label">${escapeHtml(t("mobilePairHostLabel"))}</div>`;
        html += `<img class="mobile-qr-img" alt="" src="${escapeHtml(res.host.qr)}" />`;
        html += `<div class="mobile-qr-url">${escapeHtml(res.host.url)}</div>`;
        html += `</div>`;
      }
      if (res.ip) {
        html += `<div class="mobile-qr-card">`;
        html += `<div class="mobile-qr-label">${escapeHtml(t("mobilePairIpLabel"))}</div>`;
        html += `<img class="mobile-qr-img" alt="" src="${escapeHtml(res.ip.qr)}" />`;
        html += `<div class="mobile-qr-url">${escapeHtml(res.ip.url)}</div>`;
        html += `</div>`;
      }
      html += `</div>`;
      html += `<p class="mobile-qr-hint">${escapeHtml(t("mobilePairHint"))}</p>`;
      container.innerHTML = html;
    }).catch(() => {
      if (container.parentNode) {
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobilePairQrError"))}</p>`;
      }
    });
  }

  function renderPairingCode(attempt = 0) {
    if (!pairingCodeContainer) return;
    const container = pairingCodeContainer;
    container.innerHTML = `<p class="mobile-info-loading">${escapeHtml(t("mobilePairCodeLoading"))}</p>`;

    if (!window.settingsAPI || typeof window.settingsAPI.getMobilePairingCode !== "function") return;
    window.settingsAPI.getMobilePairingCode().then((res) => {
      if (!container.parentNode) return;
      if (res && res.status === "starting" && attempt < MOBILE_INFO_MAX_RETRIES) {
        setTimeout(() => { if (container.parentNode) renderPairingCode(attempt + 1); }, MOBILE_INFO_RETRY_MS);
        return;
      }
      if (!res || res.status !== "ok" || typeof res.code !== "string" || res.code.length < 8) {
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobilePairCodeError"))}</p>`;
        return;
      }
      const first = escapeHtml(res.code.slice(0, 4));
      const second = escapeHtml(res.code.slice(4, 8));
      let html = `<div class="mobile-paircode">`;
      html += `<span class="mobile-paircode-seg">${first}</span>`;
      html += `<span class="mobile-paircode-dash">&middot;</span>`;
      html += `<span class="mobile-paircode-seg">${second}</span>`;
      html += `</div>`;
      html += `<p class="mobile-paircode-instructions">${escapeHtml(t("mobilePairCodeInstructions"))}</p>`;
      html += `<p class="mobile-paircode-hint">${escapeHtml(t("mobilePairCodeHint"))}</p>`;
      html += `<button class="soft-btn accent" id="mobile-newcode-btn">${escapeHtml(t("mobilePairNewCode"))}</button>`;
      container.innerHTML = html;

      const newBtn = container.querySelector("#mobile-newcode-btn");
      if (newBtn) {
        newBtn.addEventListener("click", () => {
          if (!window.settingsAPI || typeof window.settingsAPI.regenerateMobilePairingCode !== "function") return;
          window.settingsAPI.regenerateMobilePairingCode().then(() => renderPairingCode()).catch(() => {});
        });
      }
    }).catch(() => {
      if (container.parentNode) {
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobilePairCodeError"))}</p>`;
      }
    });
  }

  function renderDevices() {
    if (!devicesContainer) return;
    const container = devicesContainer;
    container.innerHTML = `<p class="mobile-info-loading">${escapeHtml(t("mobileDevicesLoading"))}</p>`;

    if (!window.settingsAPI || typeof window.settingsAPI.listMobileDevices !== "function") return;
    window.settingsAPI.listMobileDevices().then((res) => {
      if (!container.parentNode) return;
      if (!res || res.status !== "ok" || !Array.isArray(res.devices)) {
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobileDevicesError"))}</p>`;
        return;
      }
      if (devicesTitleEl) {
        devicesTitleEl.textContent = `${t("mobileDevicesTitle")} (${res.devices.length})`;
      }
      if (res.devices.length === 0) {
        container.innerHTML = `<p class="mobile-info-loading">${escapeHtml(t("mobileDevicesEmpty"))}</p>`;
        return;
      }
      container.innerHTML = "";
      for (const d of res.devices) {
        container.appendChild(buildDeviceRow(d));
      }
    }).catch(() => {
      if (container.parentNode) {
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobileDevicesError"))}</p>`;
      }
    });
  }

  function buildDeviceRow(device) {
    const row = document.createElement("div");
    row.className = "mobile-device-row";

    const info = document.createElement("div");
    info.className = "mobile-device-info";
    const label = document.createElement("div");
    label.className = "mobile-device-label";
    label.textContent = device.label || device.deviceId;
    info.appendChild(label);
    const meta = document.createElement("div");
    meta.className = "mobile-device-meta";
    const seen = formatTimestamp(device.lastSeen);
    meta.textContent = seen
      ? t("mobileDeviceLastSeen").replace("{time}", seen)
      : t("mobileDeviceNeverSeen");
    info.appendChild(meta);
    row.appendChild(info);

    const controls = document.createElement("div");
    controls.className = "mobile-device-controls";

    const allowWrap = document.createElement("label");
    allowWrap.className = "mobile-device-allow";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = device.approvalsAllowed !== false;
    cb.addEventListener("change", () => {
      if (window.settingsAPI && typeof window.settingsAPI.setMobileDeviceApprovals === "function") {
        window.settingsAPI.setMobileDeviceApprovals(device.deviceId, cb.checked)
          .then(() => renderDevices())
          .catch(() => {});
      }
    });
    allowWrap.appendChild(cb);
    const allowText = document.createElement("span");
    allowText.textContent = t("mobileDeviceAllowApprovals");
    allowWrap.appendChild(allowText);
    controls.appendChild(allowWrap);

    // Transcript default is OFF (unlike approvals which defaults on), so must be === true
    const transcriptWrap = document.createElement("label");
    transcriptWrap.className = "mobile-device-allow";
    const tcb = document.createElement("input");
    tcb.type = "checkbox";
    tcb.checked = device.transcriptAllowed === true;
    tcb.addEventListener("change", () => {
      if (window.settingsAPI && typeof window.settingsAPI.setMobileDeviceTranscript === "function") {
        window.settingsAPI.setMobileDeviceTranscript(device.deviceId, tcb.checked)
          .then(() => renderDevices()).catch(() => {});
      }
    });
    transcriptWrap.appendChild(tcb);
    const tText = document.createElement("span");
    tText.textContent = t("mobileDeviceAllowTranscript");
    transcriptWrap.appendChild(tText);
    controls.appendChild(transcriptWrap);

    const revokeBtn = document.createElement("button");
    revokeBtn.className = "soft-btn danger";
    revokeBtn.textContent = t("mobileDeviceRevoke");
    revokeBtn.addEventListener("click", () => {
      if (!window.confirm(t("mobileDeviceRevokeConfirm"))) return;
      if (window.settingsAPI && typeof window.settingsAPI.revokeMobileDevice === "function") {
        window.settingsAPI.revokeMobileDevice(device.deviceId)
          .then(() => renderDevices())
          .catch(() => {});
      }
    });
    controls.appendChild(revokeBtn);

    row.appendChild(controls);
    return row;
  }

  function renderPushStatus() {
    if (!pushContainer) return;
    const container = pushContainer;
    if (!window.settingsAPI || typeof window.settingsAPI.getMobilePushStatus !== "function") return;
    window.settingsAPI.getMobilePushStatus().then((res) => {
      if (!container.parentNode) return;
      if (!res || res.status !== "ok") {
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobilePushError"))}</p>`;
        return;
      }
      let html = "";
      if (res.hasVapid) {
        html += `<p class="mobile-push-line">${escapeHtml(t("mobilePushConfigured"))}</p>`;
        html += `<p class="mobile-push-line">${escapeHtml(t("mobilePushSubCount").replace("{count}", String(res.subCount || 0)))}</p>`;
      } else {
        html += `<p class="mobile-info-loading">${escapeHtml(t("mobilePushNotConfigured"))}</p>`;
      }
      container.innerHTML = html;
    }).catch(() => {
      if (container.parentNode) {
        container.innerHTML = `<p class="mobile-info-error">${escapeHtml(t("mobilePushError"))}</p>`;
      }
    });
  }

  // A titled group divided by a top rule. Returns the section; append the
  // group's body straight onto it.
  function buildSubsection(titleKey) {
    const section = document.createElement("div");
    section.className = "mobile-subsection";
    const title = document.createElement("h4");
    title.className = "mobile-subsection-title";
    title.textContent = t(titleKey);
    section.appendChild(title);
    return section;
  }

  function renderV2Sections() {
    if (!v2Container) return;
    v2Container.innerHTML = "";
    stopHttpsPoll();

    if (!mobileEnabled()) return;

    // Pair a phone — the camera-free code is the everyday path, so it leads.
    const codeSection = buildSubsection("mobilePairTitle");
    pairingCodeContainer = document.createElement("div");
    pairingCodeContainer.className = "mobile-paircode-container";
    codeSection.appendChild(pairingCodeContainer);
    v2Container.appendChild(codeSection);
    renderPairingCode();

    // Install or Connect — token-free "scan to open the app, then Add to Home Screen".
    const installSection = buildSubsection("mobileInstallTitle");
    const qrBtn = document.createElement("button");
    qrBtn.className = "soft-btn accent";
    qrBtn.textContent = qrVisible ? t("mobilePairHideQr") : t("mobilePairShowQr");
    qrBtn.addEventListener("click", () => {
      qrVisible = !qrVisible;
      qrBtn.textContent = qrVisible ? t("mobilePairHideQr") : t("mobilePairShowQr");
      renderQr();
    });
    installSection.appendChild(qrBtn);
    qrContainer = document.createElement("div");
    qrContainer.className = "mobile-qr-container";
    installSection.appendChild(qrContainer);
    v2Container.appendChild(installSection);
    renderQr();

    // Paired devices.
    const devSection = buildSubsection("mobileDevicesTitle");
    devicesTitleEl = devSection.querySelector(".mobile-subsection-title");
    devicesContainer = document.createElement("div");
    devicesContainer.className = "mobile-devices-container";
    devSection.appendChild(devicesContainer);
    v2Container.appendChild(devSection);
    renderDevices();

    // Phone permissions — what a paired phone is allowed to do.
    const permsSection = buildSubsection("mobilePermsTitle");
    permsSection.appendChild(helpers.buildSwitchRow({
      key: "mobileApprovalsEnabled",
      labelKey: "mobileApprovalsToggle",
      descKey: "mobileApprovalsToggleDesc",
    }));
    permsSection.appendChild(helpers.buildSwitchRow({
      key: "mobileTranscriptEnabled",
      labelKey: "mobileTranscriptToggle",
      descKey: "mobileTranscriptToggleDesc",
    }));
    // Only meaningful when the transcript feature is enabled
    if (snapshot().mobileTranscriptEnabled === true) {
      permsSection.appendChild(helpers.buildSwitchRow({
        key: "mobileTranscriptToolOutput",
        labelKey: "mobileTranscriptOutputToggle",
        descKey: "mobileTranscriptOutputToggleDesc",
      }));
    }
    v2Container.appendChild(permsSection);

    // Connection & security — first-time setup / troubleshooting, collapsed by
    // default so the everyday pairing controls above stay uncluttered.
    const portErrSlot = document.createElement("div");
    portErrSlot.className = "mobile-port-error";
    httpsInfoContainer = document.createElement("div");
    httpsInfoContainer.className = "mobile-https-info";
    const connDetailsTitle = document.createElement("div");
    connDetailsTitle.className = "mobile-cert-title";
    connDetailsTitle.textContent = t("mobileConnDetailsTitle");
    const connInfoContainer = document.createElement("div");
    connInfoContainer.id = "mobile-connection-info";

    const advanced = helpers.buildCollapsibleGroup({
      id: "mobileAdvanced",
      title: t("mobileAdvancedTitle"),
      desc: t("mobileAdvancedDesc"),
      defaultCollapsed: true,
      className: "mobile-advanced-group",
      children: [
        buildConnectionModeRow(),
        // Fixed ports keep a paired phone reconnecting — see buildPortRow.
        buildPortRow("mobilePort", "mobilePortTitle", "mobilePortDesc"),
        buildPortRow("mobileHttpsPort", "mobileHttpsPortTitle", "mobileHttpsPortDesc"),
        portErrSlot,
        helpers.buildSwitchRow({
          key: "mobileHttpsEnabled",
          labelKey: "mobileHttpsToggle",
          descKey: "mobileHttpsToggleDesc",
        }),
        httpsInfoContainer,
        connDetailsTitle,
        connInfoContainer,
      ],
    });
    v2Container.appendChild(advanced);
    // Populate the async slots once the group is in the tree (their renderers
    // bail unless the node already has a parent).
    renderPortBindError(portErrSlot);
    renderHttpsInfo();
    renderConnectionInfo(connInfoContainer);

    // Push notifications.
    const pushSection = buildSubsection("mobilePushTitle");
    pushContainer = document.createElement("div");
    pushContainer.className = "mobile-push-container";
    pushSection.appendChild(pushContainer);
    v2Container.appendChild(pushSection);
    renderPushStatus();
  }

  function renderMobileTab(container, core) {
    runtime = core.runtime;
    helpers = core.helpers;
    state = core.state;

    const section = document.createElement("div");
    section.className = "settings-tab-section";

    // Title & description
    const title = document.createElement("h3");
    title.textContent = t("mobileTitle") || "Mobile / PWA";
    section.appendChild(title);

    const desc = document.createElement("p");
    desc.className = "settings-tab-desc";
    desc.textContent = t("mobileDesc") || "Connect your phone to monitor sessions remotely.";
    section.appendChild(desc);

    // Enable toggle
    section.appendChild(helpers.buildSwitchRow({
      key: "mobilePreviewEnabled",
      labelKey: "mobileToggle",
      descKey: "mobileToggleDesc",
    }));

    // Everything else (pairing, install, devices, permissions, advanced, push)
    // lives below the toggle and only renders while the bridge is enabled.
    v2Container = document.createElement("div");
    v2Container.id = "mobile-v2-sections";
    section.appendChild(v2Container);

    container.appendChild(section);

    renderV2Sections();

    // Re-render on relevant pref changes. mobilePreviewEnabled gates everything;
    // mobileHttpsEnabled re-renders the cert panel (and triggers cert minting
    // main-side via the pref subscriber).
    if (!changeListenerRegistered && window.settingsAPI && typeof window.settingsAPI.onChanged === "function") {
      changeListenerRegistered = true;
      window.settingsAPI.onChanged((evt) => {
        if (!evt || !evt.changes) return;
        const c = evt.changes;
        if (Object.prototype.hasOwnProperty.call(c, "mobilePreviewEnabled")) {
          renderV2Sections();
          return;
        }
        if (Object.prototype.hasOwnProperty.call(c, "mobileTranscriptEnabled")) {
          renderV2Sections();
          return;
        }
        if (Object.prototype.hasOwnProperty.call(c, "mobileHttpsEnabled")) {
          renderHttpsInfo();
        }
      });
    }
  }

  function init(core) {
    runtime = core.runtime;
    helpers = core.helpers;
    core.tabs["mobile"] = { render: renderMobileTab };
  }

  root.ClawdSettingsTabMobile = { init };
})(globalThis);
