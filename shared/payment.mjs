export const INVITE_PRICE_FEN = 990;
export const SANDBOX_PRICE_FEN = 1;
export const paymentPriceFen = (mode) =>
  mode === "sandbox" ? SANDBOX_PRICE_FEN : INVITE_PRICE_FEN;
export const yuan = (fen) =>
  `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, "0")}`;
export const refundConfirmation = (fen) =>
  `退还${yuan(fen)}元并撤销未使用的邀请码`;
