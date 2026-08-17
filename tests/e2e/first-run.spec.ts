import { expect, test } from "@playwright/test";

test("opens with an empty session queue and keeps API key settings protected", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("待压缩列表为空", { exact: true })).toBeVisible();
  await expect(page.getByText("拖入图片或文件夹", { exact: true })).toBeVisible();
  await expect(page.getByText("首次压缩时创建时间文件夹", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "识别图片后自动压缩" })).not.toBeChecked();
  await expect(page.getByText("原图目录", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByText("未配置", { exact: true })).toBeVisible();
  const keyInput = page.getByPlaceholder("从 TinyPNG API Dashboard 获取");
  await expect(keyInput).toHaveAttribute("type", "password");
  await keyInput.fill("candidate-secret");
  await page.getByTitle("显示 API Key").click();
  await expect(keyInput).toHaveAttribute("type", "text");
});
