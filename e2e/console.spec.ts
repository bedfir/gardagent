import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, ADMIN_TOKEN, adminHeaders } from "./fixtures";

async function login(page: Page, url: string) {
  await page.goto(`${url}/console/`);
  await page.getByLabel("Admin token", { exact: true }).fill(ADMIN_TOKEN);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
}

async function createAgent(request: APIRequestContext, url: string, name: string, model = "fixture-a") {
  const response = await request.post(`${url}/admin/agents`, {
    headers: adminHeaders,
    data: { name, allowedModels: [model], allowedTools: ["local/*"], dailyBudgetUsd: 5 },
  });
  expect(response.status()).toBe(201);
  return await response.json() as { agent: { id: string }; key: string };
}

async function agents(request: APIRequestContext, url: string) {
  const response = await request.get(`${url}/admin/agents`, { headers: adminHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).agents;
}

test("rejects a wrong token, logs in, switches languages and logs out", async ({ page, gateway }) => {
  await page.goto(`${gateway.url}/console/`);
  await page.getByLabel("Admin token", { exact: true }).fill("fake-wrong-token");
  const refusal = page.waitForResponse(r => r.url().endsWith("/admin/agents") && r.status() === 401);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await refusal;
  await expect(page.getByRole("alert")).toHaveText("Invalid token.");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.getByRole("button", { name: "Français", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Jeton invalide.");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await login(page, gateway.url);
  await page.getByRole("button", { name: "Français", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tableau de bord", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Tableau de bord", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Admin token", { exact: true })).toBeVisible();
});

test("lists existing agents and creates one through the form", async ({ page, request, gateway }) => {
  await createAgent(request, gateway.url, "Existing agent");
  await login(page, gateway.url);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Existing agent" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Browser agent");
  await page.getByLabel(/^Allowed models/).fill("fixture-a");
  await page.getByLabel(/^Daily budget in dollars/).fill("5");
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Browser agent" })).toBeVisible();
  await expect(page.getByLabel("Agent key", { exact: true })).toHaveValue(/^ga_/);
  await expect.poll(async () => (await agents(request, gateway.url)).map((a: { name: string }) => a.name))
    .toEqual(["Existing agent", "Browser agent"]);
});

test("approves and rejects real pending calls and displays their history", async ({ page, request, gateway }) => {
  const { key } = await createAgent(request, gateway.url, "Approval agent");
  await login(page, gateway.url);
  for (const action of ["approve", "reject"] as const) {
    const tool = action === "approve" ? "write-approved" : "write-rejected";
    const pending = request.post(`${gateway.url}/mcp/local`, {
      headers: { authorization: `Bearer ${key}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { value: action } } },
      timeout: 28_000,
    });
    // Handle a rejected request immediately as well as when it is awaited below.
    pending.catch(() => {});
    await expect.poll(async () => {
      const response = await request.get(`${gateway.url}/admin/approvals?status=pending`, { headers: adminHeaders });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).approvals.some((a: { tool: string }) => a.tool === tool);
    }).toBe(true);
    expect(gateway.forwarded).not.toContain(tool);
    // Remount to fetch current pending state without waiting for the refresh timer.
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: /^Approvals/ }).click();
    const row = page.getByRole("row").filter({ hasText: `local/${tool}` });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: action === "approve" ? "Approve" : "Reject", exact: true }).click();
    if (action === "reject") {
      await row.getByLabel("Rejection reason", { exact: true }).fill("Browser rejection");
      await row.getByRole("button", { name: "Confirm rejection", exact: true }).click();
    }
    const response = await pending;
    expect(response.status()).toBe(200);
    const body = await response.json();
    if (action === "approve") {
      expect(body.result.content[0].text).toBe("local fixture result");
      expect(gateway.forwarded).toEqual([tool]);
      await expect(row).toContainText("approved");
    } else {
      expect(body.error.code).toBe(-32002);
      expect(gateway.forwarded).toEqual(["write-approved"]);
      await expect(row).toContainText("rejected : Browser rejection");
    }
    await expect(row.getByRole("button")).toHaveCount(0);
  }
});

test("filters real ledger entries, restores filters on reload and displays integrity", async ({ page, request, gateway }) => {
  const alpha = await createAgent(request, gateway.url, "Alpha", "fixture-a");
  const beta = await createAgent(request, gateway.url, "Beta", "fixture-b");
  for (const [key, model, status] of [[alpha.key, "fixture-a", 200], [beta.key, "fixture-b", 200], [alpha.key, "fixture-b", 403]] as const) {
    const response = await request.post(`${gateway.url}/v1/chat/completions`, {
      headers: { authorization: `Bearer ${key}` },
      data: { model, messages: [{ role: "user", content: "local fixture" }], max_tokens: 1 },
    });
    expect(response.status()).toBe(status);
  }
  await login(page, gateway.url);
  await page.getByRole("button", { name: "Ledger", exact: true }).click();
  const filters = page.getByRole("search", { name: "Ledger filters" });
  const rows = page.locator("tbody tr");
  await filters.getByLabel("Agent", { exact: true }).selectOption({ label: "Alpha" });
  await filters.getByLabel("Model", { exact: true }).selectOption("fixture-b");
  await filters.getByLabel("Verdict", { exact: true }).selectOption("denied");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(["Alpha"]);
  await expect(rows).toContainText(["model not allowed"]);
  await page.reload();
  await expect(filters.getByLabel("Model", { exact: true })).toHaveValue("fixture-b");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(["Alpha"]);
  await filters.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(rows).toHaveCount(5); // Two agent creations and three requests.
  await filters.getByLabel("Agent", { exact: true }).selectOption({ label: "Beta" });
  await filters.getByLabel("Min. cost (USD)", { exact: true }).fill("0.1");
  await filters.getByLabel("Max. cost (USD)", { exact: true }).fill("0.3");
  await filters.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(["Beta"]);
  await expect(rows).toContainText(["fixture-b"]);
  await filters.getByLabel("Min. cost (USD)", { exact: true }).fill("0.25");
  await filters.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.getByText("No entries match these filters.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Integrity", exact: true }).click();
  await page.getByRole("button", { name: "Verify ledger", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Ledger intact: 5 rows checked");
  await expect(page.locator(".hash")).toHaveText(/^[a-f0-9]{64}$/);
});
