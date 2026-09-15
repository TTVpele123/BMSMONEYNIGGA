import { describe, expect, it } from "vitest";
import { db } from "../lib/db";
import { buyerLotAlreadyTouched, recordSend, untouchedLotIds } from "../lib/ledger";
import { enrollBuyer } from "../lib/research";

function buyer(domain: string): number {
  const { buyerId } = enrollBuyer({
    company: domain,
    domain,
    categories: "closeout,apparel",
    verification_status: "verified",
    outreach_channel: "email",
  });
  return buyerId;
}

describe("email-level one-touch", () => {
  it("treats the same contact email as already touched across duplicate buyer rows", () => {
    const first = buyer("dup-one.com");
    const dup = buyer("dup-two.com");
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buy@shared-lot.com','verified')").run(first);
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buy@shared-lot.com','verified')").run(dup);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('dup-hood','hoodies','apparel-basic','matchable')").run();
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('dup-drill','drills','tools-hardware','matchable')").run();
    const hood = (db().prepare("SELECT id FROM lots WHERE external_key='dup-hood'").get() as { id: number }).id;
    const drill = (db().prepare("SELECT id FROM lots WHERE external_key='dup-drill'").get() as { id: number }).id;
    recordSend("buy@shared-lot.com", hood, first);
    expect(buyerLotAlreadyTouched(dup, [hood]).touched).toBe(true);
    expect(buyerLotAlreadyTouched(dup, [drill]).touched).toBe(false);
    expect(untouchedLotIds(dup, [hood, drill])).toEqual([drill]);
  });
});
