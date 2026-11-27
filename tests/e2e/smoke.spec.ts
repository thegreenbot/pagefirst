import { expect, test } from "@playwright/test";

test("sample mode: open a page, edit, commit and publish a preview", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pages" })).toBeVisible();
  await expect(page.getByText("These are sample pages.")).toBeVisible();

  await page.goto("/edit/about");
  // The page renders through the theme engine inside a sandboxed frame (#55).
  const preview = page.frameLocator('iframe[title="Page preview"]');
  const heading = preview.getByRole("textbox", { name: "h1 text" });
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
  await expect(heading).toHaveText(title);

  await expect(publish).toBeEnabled();
  await publish.click();
  const snapshot = page.getByRole("link", { name: "Open snapshot" });
  await expect(snapshot).toBeVisible();

  await snapshot.click();
  await expect(page).toHaveURL(/\/published\/about$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
});

test("the preview is sandboxed: theme code cannot reach the editor", async ({ page }) => {
  await page.goto("/edit/about");
  const iframe = page.locator('iframe[title="Page preview"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  const preview = page.frameLocator('iframe[title="Page preview"]');
  await expect(preview.getByRole("textbox", { name: "h1 text" })).toBeVisible();

  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  expect(frame).toBeTruthy();
  const reach = await frame!.evaluate(() => {
    const attempt = (read: () => unknown) => {
      try {
        read();
        return "read";
      } catch {
        return "blocked";
      }
    };
    return {
      origin: window.origin,
      cookie: attempt(() => document.cookie),
      storage: attempt(() => window.localStorage),
      parent: attempt(() => window.parent.document.body),
    };
  });
  expect(reach).toEqual({ origin: "null", cookie: "blocked", storage: "blocked", parent: "blocked" });
});

test("selecting a block in the preview shows its controls", async ({ page }) => {
  await page.goto("/edit/about");
  const preview = page.frameLocator('iframe[title="Page preview"]');
  await preview.locator(".columns").click({ position: { x: 4, y: 4 } });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByText("columns (contained)")).toBeVisible();
  // It is the only node in its section.
  await expect(inspector.getByRole("button", { name: "Move up" })).toBeDisabled();
  await expect(inspector.getByRole("button", { name: "Remove" })).toBeEnabled();

  await inspector.getByRole("button", { name: "Paragraph" }).click();
  await expect(page.getByRole("button", { name: "Commit" })).toBeEnabled();
});
