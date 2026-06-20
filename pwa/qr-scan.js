(function() {
  "use strict";

  // In-app QR scanner for re-pointing the installed app at the desktop. The iOS
  // home-screen (standalone) app has a frozen launch URL, so when the laptop's LAN
  // IP changes it can't reach the old address — scanning the desktop's pairing QR
  // hands it the new host:port, and the durable credential already in storage
  // reconnects without re-pairing. Decoding runs locally via the vendored jsQR
  // global; no image leaves the device.

  function t(key) {
    if (typeof window.clawdT === "function") return window.clawdT(key);
    return key;
  }

  function icon(name) {
    return (typeof ICONS !== "undefined" && ICONS[name]) || "";
  }

  function toast(msg, type) {
    if (typeof window.clawdToast === "function") window.clawdToast(msg, type);
  }

  class QrScanner {
    constructor() {
      this.overlay = document.getElementById("scanner-overlay");
      this.video = null;
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      this.stream = null;
      this.rafId = 0;
      this.scanning = false;
      this.onResult = null;
    }

    open(onResult) {
      if (!this.overlay || this.scanning) return;
      this.onResult = onResult;
      this.scanning = true;
      this._renderShell();
      this.overlay.classList.remove("hidden");
      this._startCamera();
    }

    close() {
      this._stopCamera();
      this.scanning = false;
      if (this.overlay) {
        this.overlay.classList.add("hidden");
        this.overlay.innerHTML = "";
      }
      this.video = null;
    }

    _renderShell() {
      var self = this;
      this.overlay.innerHTML =
        '<div class="scanner-header">' +
          '<span class="scanner-title">' + esc(t("scan_title")) + '</span>' +
          '<button class="scanner-close" aria-label="' + esc(t("scan_cancel")) + '">' + icon("close") + '</button>' +
        '</div>' +
        '<div class="scanner-stage">' +
          '<video class="scanner-video" autoplay playsinline muted></video>' +
          '<div class="scanner-frame"></div>' +
        '</div>' +
        '<div class="scanner-footer">' +
          '<div class="scanner-hint">' + esc(t("scan_hint")) + '</div>' +
          '<button class="scanner-photo-btn hidden">' + esc(t("scan_pick_photo")) + '</button>' +
          '<button class="scanner-cancel-btn">' + esc(t("scan_cancel")) + '</button>' +
        '</div>' +
        // No capture attribute: the fallback exists for when the live camera is
        // unavailable, so it must offer the photo library, not re-open the camera.
        '<input type="file" class="scanner-file" accept="image/*" hidden>';
      this.video = this.overlay.querySelector(".scanner-video");
      this.overlay.querySelector(".scanner-close").addEventListener("click", function() { self.close(); });
      this.overlay.querySelector(".scanner-cancel-btn").addEventListener("click", function() { self.close(); });
      this.overlay.querySelector(".scanner-photo-btn").addEventListener("click", function() {
        var f = self.overlay.querySelector(".scanner-file");
        if (f) f.click();
      });
      this.overlay.querySelector(".scanner-file").addEventListener("change", function(e) { self._onFilePicked(e); });
    }

    _startCamera() {
      var self = this;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this._fallbackToPhoto();
        return;
      }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        .then(function(stream) {
          if (!self.scanning) { stream.getTracks().forEach(function(tr) { tr.stop(); }); return; }
          self.stream = stream;
          self.video.srcObject = stream;
          // iOS needs an explicit play() after setting srcObject.
          var p = self.video.play();
          if (p && p.catch) p.catch(function() {});
          self.rafId = requestAnimationFrame(function() { self._tick(); });
        })
        .catch(function() {
          // Permission denied / no camera / insecure context — offer the photo path.
          self._fallbackToPhoto();
        });
    }

    _stopCamera() {
      if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
      if (this.stream) {
        this.stream.getTracks().forEach(function(tr) { tr.stop(); });
        this.stream = null;
      }
      if (this.video) { try { this.video.srcObject = null; } catch {} }
    }

    _tick() {
      if (!this.scanning || !this.video) return;
      var v = this.video;
      if (v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
        this.canvas.width = v.videoWidth;
        this.canvas.height = v.videoHeight;
        this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
        var hit = this._decode();
        if (hit) { this._handleResult(hit); return; }
      }
      var self = this;
      this.rafId = requestAnimationFrame(function() { self._tick(); });
    }

    _decode() {
      if (typeof window.jsQR !== "function") return null;
      var img;
      try { img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height); } catch { return null; }
      var code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      return code && code.data ? code.data : null;
    }

    _fallbackToPhoto() {
      if (!this.overlay) return;
      toast(t("scan_camera_denied"), "error");
      var stage = this.overlay.querySelector(".scanner-stage");
      var hint = this.overlay.querySelector(".scanner-hint");
      var photoBtn = this.overlay.querySelector(".scanner-photo-btn");
      if (stage) stage.classList.add("photo-mode");
      if (hint) hint.textContent = t("scan_photo_hint");
      // iOS only honors a file-input click triggered by a live user gesture. The
      // camera rejection arrives async (the original tap is spent), so a
      // programmatic click() here is silently dropped — reveal a button the user
      // taps instead, which opens the picker from a fresh gesture.
      if (photoBtn) photoBtn.classList.remove("hidden");
    }

    _onFilePicked(e) {
      var self = this;
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var img = new Image();
      img.onload = function() {
        self.canvas.width = img.naturalWidth;
        self.canvas.height = img.naturalHeight;
        self.ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(img.src);
        var hit = self._decode();
        if (hit) self._handleResult(hit);
        else toast(t("scan_invalid"), "error");
      };
      img.onerror = function() { URL.revokeObjectURL(img.src); toast(t("scan_invalid"), "error"); };
      img.src = URL.createObjectURL(file);
    }

    _handleResult(text) {
      var cb = this.onResult;
      this.close();
      if (cb) cb(text);
    }
  }

  // esc may be defined in app.js's IIFE scope (not global), so keep a local copy.
  function esc(str) {
    var d = document.createElement("div");
    d.textContent = str == null ? "" : str;
    return d.innerHTML;
  }

  window.QrScanner = QrScanner;
})();
