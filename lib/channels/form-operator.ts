import { AUTHORIZED_SENDER } from "../email/address";
import type { ChannelOperator } from "./types";
import { executeForm } from "./form-exec";

export const formOperator: ChannelOperator = {
  id: "form",
  liveExecution: true,
  requiresHumanApproval: false,
  compose(ctx) {
    const facts = ctx.lots.map((l) => {
      const qty = l.quantity != null ? `${l.quantity} units` : "qty on request";
      const price = l.unit_price != null ? `$${l.unit_price}/unit` : "price on request";
      return `• ${l.title} — ${l.category} — ${qty} — ${price}`;
    }).join("\n");
    return {
      subject: `Wholesale availability — ${ctx.lots.map((l) => l.title).join(" / ")}`.slice(0, 140),
      body: [
        `Company: Saefam Overstock`,
        `Contact: Bailey Saevitzon`,
        `Email: ${AUTHORIZED_SENDER}`,
        `Phone: 818-406-8612`,
        "",
        `For: ${ctx.company} (${ctx.domain})`,
        `Form: ${ctx.endpoint.handle}`,
        "",
        "Supplier facts only:",
        facts || "• lot facts on request",
        "",
        "Original Oliver product photos attached when the form accepts files.",
      ].join("\n"),
    };
  },
  execute(ctx, prepared) {
    return executeForm(ctx, prepared);
  },
};
