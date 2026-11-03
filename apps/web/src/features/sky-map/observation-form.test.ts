import { expect, it } from "vitest";
import { draftAt, requestFromDraft, sameObservation } from "./observation-form.js";
const draft = { label: "Synteettinen koepaikka", latitude: "60", longitude: "25", elevation: "0", timeZone: "Europe/Helsinki", localTime: "2024-10-27T03:30:00", offset: "180" };
it("keeps the two DST fold instants distinct with an explicit UTC offset", () => {
  const summer = requestFromDraft(draft), winter = requestFromDraft({ ...draft, offset: "120" });
  expect(summer.atUtc).toBe("2024-10-27T00:30:00.000Z");
  expect(winter.atUtc).toBe("2024-10-27T01:30:00.000Z");
  expect(Object.keys(summer).sort()).toEqual(["atUtc", "observer", "timeZone"]);
  expect(sameObservation(summer, winter)).toBe(false);
});
it("rejects the DST gap, blank coordinates and invalid latitudes instead of inventing a site", () => {
  expect(() => requestFromDraft({ ...draft, localTime: "2024-03-31T03:30:00", offset: "120" })).toThrow();
  expect(() => requestFromDraft({ ...draft, latitude: "" })).toThrow();
  expect(() => requestFromDraft({ ...draft, latitude: "91" })).toThrow();
});
it("updates local time across midnight without changing the explicit site", () => {
  const next = draftAt(new Date("2024-10-26T23:30:00Z"), "Europe/Helsinki", draft);
  expect(next.localTime).toBe("2024-10-27T02:30:00"); expect(next.offset).toBe("180");
  expect(next.latitude).toBe("60"); expect(next.longitude).toBe("25");
});
