import { expect, test } from "@playwright/test";

test("sample mode: open a page, edit, commit and publish a preview", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pages" })).toBeVisible();
  await expect(page.getByText("These are sample pages.")).toBeVisible();

  await page.goto("/edit/about");
  const heading = page.getByRole("textbox", { name: "h1 text" });
  await expect(heading).toHaveText("About the studio");

  const commit = page.getByRole("button", { name: "Commit" });
  const publish = page.getByRole("button", { name: "Publish" });
  await expect(commit).toBeDisabled();

  const title = `Smoke test ${Date.now()}`;
  await heading.fill(title);
  await heading.blur();

  await expect(commit).toBeEnabled();
  await expect(publish).toBeDisabled();
  await commit.click();
  await expect(page.getByRole("status")).toHaveText("Committed.");

  await expect(publish).toBeEnabled();
  await publish.click();
  const snapshot = page.getByRole("link", { name: "Open snapshot" });
  await expect(snapshot).toBeVisible();

  await snapshot.click();
  await expect(page).toHaveURL(/\/published\/about$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
});
