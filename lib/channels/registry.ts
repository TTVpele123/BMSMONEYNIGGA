import { applicationOperator, formOperator, instagramOperator, linkedinOperator, marketplaceOperator, otherOperator, phoneOperator } from "./deferred";
import { emailOperator } from "./email";
import type { ChannelId, ChannelOperator } from "./types";

const operators = new Map<ChannelId, ChannelOperator>([
  ["email", emailOperator],
  ["form", formOperator],
  ["instagram", instagramOperator],
  ["linkedin", linkedinOperator],
  ["marketplace", marketplaceOperator],
  ["application", applicationOperator],
  ["phone", phoneOperator],
  ["other", otherOperator],
]);

export function getOperator(id: ChannelId): ChannelOperator {
  const op = operators.get(id);
  if (!op) throw new Error(`no channel operator registered: ${id}`);
  return op;
}

export function registerOperator(op: ChannelOperator): void {
  operators.set(op.id, op);
}

export function listOperators(): ChannelOperator[] {
  return [...operators.values()];
}
