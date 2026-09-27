(function () {
  "use strict";

  var SOURCE = "richespay-checkout";
  var activeModal = null;

  function removeActiveModal(triggerClose) {
    if (!activeModal) {
      return;
    }

    window.removeEventListener("message", activeModal.handleMessage);
    document.removeEventListener("keydown", activeModal.handleKeydown);
    activeModal.overlay.remove();

    var onClose = activeModal.onClose;
    activeModal = null;

    if (triggerClose && typeof onClose === "function") {
      onClose();
    }
  }

  function createOverlay() {
    var overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "9999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.background = "rgba(17, 24, 39, 0.45)";
    overlay.style.backdropFilter = "blur(4px)";
    return overlay;
  }

  function createDialog(url) {
    var dialog = document.createElement("div");
    dialog.style.position = "relative";
    dialog.style.width = "min(480px, calc(100vw - 24px))";
    dialog.style.height = "min(840px, calc(100vh - 24px))";
    dialog.style.borderRadius = "24px";
    dialog.style.overflow = "hidden";
    dialog.style.background = "#ffffff";
    dialog.style.boxShadow = "0 24px 80px rgba(15, 23, 42, 0.24)";

    var closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close checkout");
    closeButton.textContent = "x";
    closeButton.style.position = "absolute";
    closeButton.style.top = "12px";
    closeButton.style.right = "12px";
    closeButton.style.width = "36px";
    closeButton.style.height = "36px";
    closeButton.style.border = "none";
    closeButton.style.borderRadius = "999px";
    closeButton.style.background = "rgba(255, 255, 255, 0.92)";
    closeButton.style.color = "#111827";
    closeButton.style.cursor = "pointer";
    closeButton.style.fontSize = "18px";
    closeButton.style.lineHeight = "1";
    closeButton.style.zIndex = "2";
    closeButton.addEventListener("click", function () {
      removeActiveModal(true);
    });

    var iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.title = "RichesPay Checkout";
    iframe.allow = "payment *";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.style.background = "#ffffff";

    dialog.appendChild(closeButton);
    dialog.appendChild(iframe);

    return {
      dialog: dialog,
      iframe: iframe
    };
  }

  function open(options) {
    if (!options || typeof options.url !== "string" || options.url.trim() === "") {
      throw new Error("RichesPayCheckout.open(...) requires a checkout URL.");
    }

    removeActiveModal(false);

    var overlay = createOverlay();
    var dialogParts = createDialog(options.url);
    overlay.appendChild(dialogParts.dialog);
    document.body.appendChild(overlay);

    var handleMessage = function (event) {
      var data = event.data;
      if (!data || data.source !== SOURCE) {
        return;
      }

      window.dispatchEvent(
        new CustomEvent("richespay.checkout.event", {
          detail: data
        })
      );

      if (typeof options.onEvent === "function") {
        options.onEvent(data);
      }

      if (data.type === "checkout.success") {
        if (typeof options.onSuccess === "function") {
          options.onSuccess(data);
        }

        removeActiveModal(false);
      }
    };

    var handleKeydown = function (event) {
      if (event.key === "Escape") {
        removeActiveModal(true);
      }
    };

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        removeActiveModal(true);
      }
    });

    window.addEventListener("message", handleMessage);
    document.addEventListener("keydown", handleKeydown);

    activeModal = {
      handleKeydown: handleKeydown,
      handleMessage: handleMessage,
      onClose: options.onClose,
      overlay: overlay
    };
  }

  window.RichesPayCheckout = {
    close: function () {
      removeActiveModal(true);
    },
    open: open
  };
})();
