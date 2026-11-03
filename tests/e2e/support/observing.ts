import { expect, type Page } from "@playwright/test";
export async function addPlace(page: Page, name = "Synteettinen A", latitude = "60", longitude = "25", timeZone = "Europe/Helsinki") {
  const settings = page.getByRole("region", { name: "Havaintopaikat", exact: true });
  await settings.getByRole("button", { name: "Lisää paikka", exact: true }).click();
  await settings.getByLabel("Paikan nimi", { exact: true }).fill(name);
  await settings.getByLabel("Leveysaste °", { exact: true }).fill(latitude);
  await settings.getByLabel("Pituusaste °", { exact: true }).fill(longitude);
  await settings.getByLabel("Aikavyöhyke", { exact: true }).fill(timeZone);
  await settings.getByRole("button", { name: "Tallenna ja käytä paikkaa", exact: true }).click();
  await expect(page.getByRole("status", { name: "Paikkojen tila", exact: true })).toHaveText("Aktiivinen paikka: " + name);
}
export async function setSyntheticTime(page: Page) {
  await page.getByLabel("Paikallinen aika", { exact: true }).fill("2024-03-31T02:30");
  await page.getByLabel("UTC-poikkeama (min)", { exact: true }).fill("120");
  await page.getByRole("button", { name: "Näytä taivas", exact: true }).click();
}
