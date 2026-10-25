import { yuan, refundConfirmation } from "../shared/payment.mjs";
const STORAGE_KEY = "keyword.purchase.v1";
const STATES = {
  pending: "等待付款。若已付款，请查询结果，不要重复支付。",
  closing: "正在关闭订单。库存将在支付宝确认关闭后恢复；请勿继续付款。",
  paid: "付款已确认，你的邀请码已备好。",
  closed: "订单已关闭，未发放邀请码。",
  refund_pending: "退款正在核对，邀请码已暂停使用。",
  refunded: "已确认全额退款，邀请码已撤销。",
};
const date = (time) =>
  new Date(time).toLocaleString("zh-CN", { hour12: false });
const validProof = (value) =>
  value?.version === 1 &&
  /^[a-f0-9-]{36}$/.test(value.requestId || "") &&
  /^[A-Za-z0-9_-]{43}$/.test(value.receipt || "") &&
  (!value.id || /^[a-f0-9-]{36}$/.test(value.id));

export function setupPurchases({ api, assertAdmin, useCode }) {
  const $ = (id) => document.getElementById(id);
  let proof,
    order,
    sale,
    stockVersion,
    adminEpoch = 0;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (validProof(stored)) proof = stored;
  } catch {}
  const setError = (error) => {
    $("purchaseError").textContent = error?.message || String(error);
  };
  function save(value) {
    // Persist BEFORE creating an order. If persistence fails, do not sell a code
    // which this browser would be unable to retrieve after the Alipay redirect.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    proof = value;
  }
  async function request(path, { body, receipt = false } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(receipt
            ? {
                "X-Keyword-Receipt":
                  receipt === true ? proof?.receipt || "" : receipt,
              }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("暂时无法连接，请保留领取凭据后重试，不要重复付款。");
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "订单操作失败，请重试");
    return data;
  }
  async function doing(button, task) {
    const text = button.textContent;
    button.disabled = true;
    button.textContent = "处理中…";
    $("purchaseError").textContent = "";
    try {
      await task();
    } catch (error) {
      setError(error);
    } finally {
      button.disabled = false;
      button.textContent = text;
    }
  }
  function render() {
    $("purchaseAmount").textContent = "¥" + yuan(sale?.amountFen || 990);
    $("buyInviteButton").textContent =
      `${sale?.mode === "sandbox" ? "沙箱购买邀请码" : "购买邀请码"} · ¥${yuan(sale?.amountFen || 990)}`;
    $("buyInviteButton").hidden = !sale?.configured && !proof;
    $("purchaseEnvironment").textContent =
      sale?.mode === "sandbox" ? "支付宝沙箱 · 仅模拟资金" : "邀请码购买";
    $("purchaseAvailability").textContent = sale?.configured
      ? sale.available
        ? sale.mode === "sandbox"
          ? "仅模拟资金，测试价 ¥0.01；正式邀请码售价 ¥9.90。"
          : "支付成功后自动发码，只授予普通账号注册权限。"
        : "本批暂未开放或已售罄，已有订单仍可查询。"
      : "暂未开通在线购买，请联系管理员获取邀请码。";
    $("purchaseCreate").hidden = Boolean(order || proof?.id);
    $("purchaseCreate").disabled = !sale?.available && !(proof && !proof.id);
    $("purchaseCreate").textContent =
      proof && !proof.id ? "恢复上次购买请求" : "购买一个邀请码";
    $("purchaseOrder").hidden = !order;
    if (!order) return;
    let stateText = STATES[order.state] || "支付结果尚未确认，请查询。";
    if (order.invitationUsed)
      stateText = "此邀请码已完成注册，请使用已注册账号登录。";
    else if (order.invitationRevoked && order.state === "paid")
      stateText = "邀请码已被管理员撤销，请提供订单号联系管理员。";
    $("purchaseState").textContent = stateText;
    $("purchaseNumber").textContent =
      "订单 " + order.number + " · ¥" + yuan(order.amountFen);
    $("purchasePay").textContent = "前往支付宝付款 · ¥" + yuan(order.amountFen);
    $("purchaseCodePanel").hidden = !order.code;
    $("purchaseCode").value = order.code || "";
    $("purchasePay").hidden =
      order.state !== "pending" ||
      order.amountFen !== sale?.amountFen ||
      order.expiresAt - Date.now() < 60000;
    $("purchaseClose").hidden = !["pending", "closing"].includes(order.state);
    const changedSandboxPrice =
      sale?.mode === "sandbox" &&
      order.amountFen !== sale.amountFen &&
      order.state === "closing";
    $("purchaseNew").hidden =
      !["closed", "refunded", "paid"].includes(order.state) &&
      !changedSandboxPrice;
    $("purchaseNew").textContent = changedSandboxPrice
      ? "按新沙箱测试价格下单"
      : "再购买一个";
    $("purchaseRefresh").textContent = ["closed", "refunded"].includes(
      order.state,
    )
      ? "刷新订单"
      : "查询支付结果";
    $("purchaseError").textContent = order.lastError || "";
  }
  async function availability() {
    sale = await request("/api/purchase/status");
    render();
  }
  async function refresh({ query = false } = {}) {
    if (!proof?.id) return;
    const activeProof = proof;
    const data = await request(
      `/api/purchase/orders/${proof.id}${query ? "/refresh" : ""}`,
      {
        ...(query ? { body: {} } : {}),
        receipt: true,
      },
    );
    if (proof !== activeProof) return;
    order = data.order;
    render();
  }
  async function open() {
    if (!$("purchaseDialog").open) $("purchaseDialog").showModal();
    $("purchaseError").textContent = "";
    try {
      await availability();
      await refresh({ query: true });
    } catch (error) {
      setError(error);
    }
  }
  $("buyInviteButton").addEventListener("click", open);
  $("purchaseCreate").addEventListener("click", () =>
    doing($("purchaseCreate"), async () => {
      if (!proof || proof.id) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const receipt = btoa(String.fromCharCode(...bytes))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
        try {
          save({ version: 1, requestId: crypto.randomUUID(), receipt });
        } catch {
          throw new Error("浏览器未允许保存领取凭据，请允许本地存储后再购买。");
        }
      }
      const activeProof = proof;
      const data = await request("/api/purchase/orders", {
        body: {
          requestId: activeProof.requestId,
          receipt: activeProof.receipt,
        },
      });
      if (proof !== activeProof) return;
      save({ ...activeProof, id: data.order.id });
      order = data.order;
      render();
    }),
  );
  $("purchasePay").addEventListener("click", () =>
    doing($("purchasePay"), async () => {
      const activeProof = proof;
      const data = await request(`/api/purchase/orders/${activeProof.id}/pay`, {
        body: {},
        receipt: true,
      });
      if (proof !== activeProof) return;
      // This is the SDK's signed GET URL, not a form string or a client-built URL.
      location.assign(data.paymentUrl);
    }),
  );
  $("purchaseRefresh").addEventListener("click", () =>
    doing($("purchaseRefresh"), () => refresh({ query: true })),
  );
  $("purchaseClose").addEventListener("click", () =>
    doing($("purchaseClose"), async () => {
      if (!confirm("取消此待付款订单？若已付款，请先查询支付结果。")) return;
      const activeProof = proof;
      const data = await request(
        `/api/purchase/orders/${activeProof.id}/close`,
        {
          body: {},
          receipt: true,
        },
      );
      if (proof !== activeProof) return;
      order = data.order;
      render();
    }),
  );
  $("purchaseUse").addEventListener("click", () => {
    if (order?.code) {
      $("purchaseDialog").close();
      useCode(order.code);
    }
  });
  $("purchaseSave").addEventListener("click", () => {
    if (!proof) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(proof, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `KeyWord-领取凭据-${proof.id || proof.requestId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("purchaseNew").addEventListener("click", () => {
    if (
      order?.state === "paid" &&
      !order.invitationUsed &&
      !confirm("请先保存当前邀请码或领取凭据。继续购买另一个？")
    )
      return;
    localStorage.removeItem(STORAGE_KEY);
    proof = null;
    order = null;
    $("purchaseError").textContent = "";
    availability().catch(setError);
  });
  $("purchaseRecover").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    try {
      if (!file || file.size > 4096)
        throw new Error("请选择正确的领取凭据文件（不超过4KB）。");
      const restored = JSON.parse(await file.text());
      if (!validProof(restored)) throw new Error("领取凭据格式不正确。");
      // Check ownership before replacing the browser's current receipt.
      const previous = proof;
      const data = restored.id
        ? await request(`/api/purchase/orders/${restored.id}`, {
            receipt: restored.receipt,
          })
        : await request("/api/purchase/orders", {
            body: {
              requestId: restored.requestId,
              receipt: restored.receipt,
            },
          });
      if (proof !== previous)
        throw new Error("订单已在其他标签页变化，请重新导入领取凭据。");
      save({ ...restored, id: data.order.id });
      order = data.order;
      $("purchaseError").textContent = "";
      render();
    } catch (error) {
      setError(error);
    } finally {
      event.target.value = "";
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    try {
      const next = JSON.parse(event.newValue || "null");
      proof = validProof(next) ? next : null;
      order = null;
      render();
      if ($("purchaseDialog").open) refresh().catch(setError);
    } catch {
      proof = null;
      order = null;
      render();
    }
  });
  availability().catch(() => {
    if (proof) $("buyInviteButton").hidden = false;
  });

  // Synchronous return parameters are deliberately discarded, not trusted. Only
  // this browser's receipt can locate an order and authorize server-side query.
  const returned = location.pathname === "/payment/return";
  if (returned) history.replaceState(null, "", "/payment/return");

  async function loadAdmin() {
    assertAdmin();
    const epoch = adminEpoch;
    try {
      const data = await api("/api/admin/payments");
      if (epoch !== adminEpoch) return;
      const editing = $("paymentStockForm").contains(document.activeElement);
      if (!editing || stockVersion === undefined) {
        stockVersion = data.version;
        $("paymentAvailable").value = data.available;
        $("paymentSaleEnabled").checked = data.enabled;
      }
      $("paymentStockForm").hidden = !data.configured;
      $("paymentAdminSummary").textContent = !data.configured
        ? data.configurationError || "在线支付未配置；手工邀请码正常使用。"
        : `${data.mode === "sandbox" ? "沙箱模拟" : "正式支付"} · ¥${yuan(data.amountFen)} / 个 · ${data.available} 个可售 · ${data.reserved} 个待付款占位 · ${data.sold} 个已售`;
      renderAdminOrders(data.orders);
    } catch (error) {
      if (epoch === adminEpoch && error.code !== "STALE_ACCOUNT")
        $("paymentAdminFeedback").textContent = error.message;
    }
  }
  function make(tag, text, className = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  async function adminAction(row, action, button) {
    const id = row.id;
    assertAdmin();
    let confirmation;
    if (action === "refund") {
      if (
        !confirm(
          `向原付款方全额退还 ¥${yuan(row.amountFen)}，并撤销此未使用的邀请码？此操作会实际发起退款。`,
        )
      )
        return;
      confirmation = refundConfirmation(row.amountFen);
    } else if (
      action === "close" &&
      !confirm("确认向支付宝请求关闭此未付款订单？")
    )
      return;
    const epoch = adminEpoch;
    button.disabled = true;
    try {
      const data = await api(`/api/admin/payments/${id}/${action}`, {
        method: "POST",
        body: confirmation ? { confirmation } : {},
      });
      if (epoch !== adminEpoch) return;
      $("paymentAdminFeedback").textContent =
        data.order.lastError || "订单状态已更新。";
      await loadAdmin();
    } catch (error) {
      if (epoch === adminEpoch && error.code !== "STALE_ACCOUNT")
        $("paymentAdminFeedback").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  function renderAdminOrders(orders) {
    const list = $("paymentOrderList");
    list.replaceChildren();
    if (!orders.length) list.append(make("p", "暂无在线购买订单。", "muted"));
    for (const row of orders) {
      const item = make("article", "", "payment-admin-order");
      const info = make("div", "");
      info.append(
        make("strong", row.number),
        make(
          "p",
          `¥${yuan(row.amountFen)} · ${STATES[row.state] || row.state} · ${date(row.createdAt)}`,
          "muted",
        ),
      );
      if (row.invitationUsed)
        info.append(make("p", "邀请码已注册使用", "muted"));
      const actions = make("div", "", "payment-order-actions");
      for (const [action, label] of [
        ["refresh", "查询"],
        ...(["pending", "closing"].includes(row.state)
          ? [["close", "关单"]]
          : []),
        ...(["paid", "refund_pending"].includes(row.state) &&
        !row.invitationUsed
          ? [
              [
                "refund",
                row.state === "refund_pending" ? "重试原退款" : "全额退款",
              ],
            ]
          : []),
        ...(row.state === "refund_pending" ? [["refund-query", "查退款"]] : []),
      ]) {
        const b = make("button", label, "text-button");
        b.type = "button";
        b.addEventListener("click", () => adminAction(row, action, b));
        actions.append(b);
      }
      item.append(info, actions);
      list.append(item);
    }
  }
  $("paymentStockForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const epoch = adminEpoch;
    $("paymentStockSave").disabled = true;
    try {
      assertAdmin();
      await api("/api/admin/payments/stock", {
        method: "POST",
        body: {
          enabled: $("paymentSaleEnabled").checked,
          available: Number($("paymentAvailable").value),
          version: stockVersion,
        },
      });
      if (epoch !== adminEpoch) return;
      $("paymentAdminFeedback").textContent =
        "销售设置已保存。已发放和待付款订单不受销售开关影响。";
      stockVersion = undefined;
      await loadAdmin();
      await availability();
    } catch (error) {
      if (epoch === adminEpoch && error.code !== "STALE_ACCOUNT")
        $("paymentAdminFeedback").textContent = error.message;
    } finally {
      $("paymentStockSave").disabled = false;
    }
  });
  return {
    loadAdmin,
    openReturned: () => {
      if (returned) return open();
    },
    clearAdmin() {
      adminEpoch++;
      stockVersion = undefined;
      $("paymentOrderList").replaceChildren();
      $("paymentAdminFeedback").textContent = "";
      $("paymentAdminSummary").textContent = "";
      $("paymentAvailable").value = "0";
      $("paymentSaleEnabled").checked = false;
    },
  };
}
