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
  await expect(page.locator(".key-state")).toHaveText("未配置");
  const keyInput = page.getByPlaceholder("从 TinyPNG API Dashboard 获取");
  await expect(keyInput).toHaveAttribute("type", "password");
  await keyInput.fill("candidate-secret");
  await page.getByTitle("显示 API Key").click();
  await expect(keyInput).toHaveAttribute("type", "text");
});

test("renames an API key inline without browser prompt dialogs", async ({ page }) => {
  let keyName = "默认 Key";
  let renameRequests = 0;
  const keyView = () => ({
    id: "key-1", name: keyName, active: true, used: 4, limit: 500, remaining: 496,
    status: "available", canCompress: true, stale: false, source: "cache",
    lastValidationStatus: "valid", lastValidatedAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z"
  });
  await page.route("**/api/tinypng/keys**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/tinypng/keys") {
      await route.fulfill({ json: { data: { items: [keyView()], activeKeyId: "key-1" }, meta: { requestId: "test" } } });
      return;
    }
    if (request.method() === "PATCH" && pathname === "/api/tinypng/keys/key-1") {
      renameRequests += 1;
      const candidate = (request.postDataJSON() as { name: string }).name;
      if (candidate === "重复名称") {
        await route.fulfill({ status: 409, json: { error: { code: "DUPLICATE_API_KEY_NAME", message: "API Key 名称已存在" }, meta: { requestId: "test" } } });
        return;
      }
      keyName = candidate;
      await route.fulfill({ json: { data: keyView(), meta: { requestId: "test" } } });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByTitle("重命名 默认 Key").click();
  const firstEdit = page.getByRole("textbox", { name: "重命名 默认 Key" });
  await firstEdit.fill("取消名称");
  await firstEdit.press("Escape");
  await expect(firstEdit).toHaveCount(0);
  expect(renameRequests).toBe(0);

  await page.getByTitle("重命名 默认 Key").click();
  const edit = page.getByRole("textbox", { name: "重命名 默认 Key" });
  await edit.fill("工作账号");
  await edit.press("Enter");
  await expect(page.getByText("工作账号", { exact: true })).toBeVisible();
  await expect(page.getByText("名称已更新", { exact: true })).toBeVisible();
  expect(renameRequests).toBe(1);

  await page.getByTitle("重命名 工作账号").click();
  const failedEdit = page.getByRole("textbox", { name: "重命名 工作账号" });
  await failedEdit.fill("重复名称");
  await failedEdit.press("Enter");
  await expect(page.getByRole("alert")).toContainText("API Key 名称已存在");
  await expect(failedEdit).toHaveValue("重复名称");
  expect(renameRequests).toBe(2);
});
