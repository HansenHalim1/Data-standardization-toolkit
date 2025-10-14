import { test, expect } from "@playwright/test";
import jwt from "jsonwebtoken";

test("board view preview and execute flow", async ({ page }) => {
  const token = jwt.sign(
    { accountId: "demo-account", userId: "user-1", region: "us-east-1" },
    process.env.MONDAY_CLIENT_SECRET ?? "test-secret",
    { expiresIn: "5m" }
  );

  await page.goto(`/monday/view?token=${encodeURIComponent(token)}`);

  await expect(page.getByText("Data Standardization Toolkit")).toBeVisible();

  await page.route("**/api/recipes/run/execute", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rowsWritten: 1, errors: [], usageUpdated: true })
    });
  });

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "contacts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "FirstName,LastName,Email,Phone,Country",
        "ada,lovelace,Test.User+alias@example.com,(415) 555-1234,United States"
      ].join("\n")
    )
  });

  const previewButton = page.getByRole("button", { name: "Preview recipe" });
  await expect(previewButton).toBeEnabled({ timeout: 10_000 });
  await previewButton.click();

  await expect(page.getByText("Preview ready")).toBeVisible({ timeout: 10_000 });

  await expect(page.locator('text="+14155551234"').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text="testuser@example.com"').first()).toBeVisible();

  const executeButton = page.getByRole("button", { name: "Run write-back" });
  await expect(executeButton).toBeEnabled({ timeout: 10_000 });
  await executeButton.click();
  await page.waitForTimeout(100); // allow toast render
  await expect(page.getByText("Run complete", { exact: false }).first()).toBeVisible({
    timeout: 10_000
  });
});

