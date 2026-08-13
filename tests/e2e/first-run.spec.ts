import { expect, test } from "@playwright/test";

test("shows the first-run settings and protects the API key", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "开始使用" })).toBeVisible();
  await expect(page.getByText("未配置", { exact: true })).toBeVisible();
  const keyInput = page.getByPlaceholder("从 TinyPNG API Dashboard 获取");
  await expect(keyInput).toHaveAttribute("type", "password");
  await keyInput.fill("candidate-secret");
  await page.getByTitle("显示 API Key").click();
  await expect(keyInput).toHaveAttribute("type", "text");
});
