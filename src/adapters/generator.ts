import type { LocatorSpec, Scenario } from "../core/model.js";
import { validateScenario } from "../core/model.js";
const quote = (value: unknown) => JSON.stringify(value);
function locator(spec?: LocatorSpec) {
  if (!spec) throw new Error("조작 대상이 없는 단계입니다.");
  switch (spec.kind) {
    case "label":
      return `page.getByLabel(${quote(spec.value)}, { exact: true })`;
    case "testId":
      return `page.getByTestId(${quote(spec.value)})`;
    case "role":
      return `page.getByRole(${quote(spec.value)}, { name: ${quote(spec.name)}, exact: true })`;
    case "text":
      return `page.getByText(${quote(spec.value)}, { exact: true })`;
    case "css":
      return `page.locator(${quote(spec.value)})`;
  }
}
export function generateTest(scenario: Scenario) {
  validateScenario(scenario.steps, scenario.assertions);
  const lines = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `// Set BASE_URL to an isolated test environment. Review prerequisites before running.`,
    `// ${scenario.prerequisites.replace(/[\r\n]/g, " ")}`,
    `// Optional private browser preparation. Never commit the storage-state file.`,
    `test.use({ storageState: process.env.STORAGE_STATE || undefined });`,
    `test(${quote(scenario.name)}, async ({ page: initialPage, context }) => {`,
    `  const baseURL = process.env.BASE_URL;`,
    `  if (!baseURL) throw new Error('BASE_URL is required');`,
    `  const pages = new Map([['page-1', initialPage]]);`,
    `  let page = initialPage;`,
    `  await page.goto(baseURL);`,
  ];
  const assertAt = (index: number) => {
    for (const a of scenario.assertions.filter(
      (a) => (a.afterStep ?? scenario.steps.length) === index,
    )) {
      lines.push(`  page = pages.get(${quote(a.pageId)})!;`);
      if (a.kind === "manual")
        lines.push(
          `  throw new Error(${quote("Manual verification required: " + a.expected)});`,
        );
      else if (a.kind === "url")
        lines.push(`  await expect(page).toHaveURL(${quote(a.expected)});`);
      else {
        const l = locator(a.locator);
        const method = {
          visible: "toBeVisible()",
          hidden: "toBeHidden()",
          text: `toHaveText(${quote(a.expected)})`,
          value: `toHaveValue(${quote(a.expected)})`,
          count: `toHaveCount(${Number(a.expected)})`,
        }[a.kind];
        lines.push(`  await expect(${l}).${method};`);
      }
    }
  };
  assertAt(0);
  scenario.steps.forEach((step, index) => {
    lines.push(`  // Step ${index + 1}: ${step.type}`);
    if (step.type === "manual") {
      lines.push(
        `  throw new Error(${quote("Manual verification required: " + step.detail)});`,
      );
      return;
    }
    if (step.type === "page-open") {
      lines.push(
        `  pages.set(${quote(step.pageId)}, context.pages().find(p => ![...pages.values()].includes(p))!);`,
      );
    } else {
      lines.push(`  page = pages.get(${quote(step.pageId)})!;`);
      if (step.type === "navigate") {
        lines.push(
          `  await page.goto(new URL(${quote(step.url || "/")}, baseURL).href);`,
        );
      } else if (step.type === "reload") lines.push(`  await page.reload();`);
      else if (step.type === "page-close") lines.push(`  await page.close();`);
      else if (step.type === "press" && !step.locator)
        lines.push(`  await page.keyboard.press(${quote(step.value)});`);
      else {
        const l = locator(step.locator);
        lines.push(`  await expect(${l}).toHaveCount(1);`);
        if (step.type === "click")
          lines.push(
            `  await ${l}.${step.detail === "double" ? "dblclick" : "click"}();`,
          );
        if (step.type === "fill")
          lines.push(`  await ${l}.fill(${quote(step.value ?? "")});`);
        if (step.type === "check")
          lines.push(`  await ${l}.setChecked(${!!step.checked});`);
        if (step.type === "select")
          lines.push(`  await ${l}.selectOption(${quote(step.value)});`);
        if (step.type === "press")
          lines.push(`  await ${l}.press(${quote(step.value)});`);
        if (step.type === "upload")
          lines.push(
            `  if (!process.env[${quote("GV_FILE_" + (step.fileId || "REQUIRED"))}]) throw new Error('Test file binding required');`,
            `  await ${l}.setInputFiles(process.env[${quote("GV_FILE_" + (step.fileId || "REQUIRED"))}]!);`,
          );
      }
    }
    assertAt(index + 1);
  });
  if (!scenario.assertions.length)
    lines.push(
      `  throw new Error('No assertions: manual verification required');`,
    );
  lines.push("});", "");
  return lines.join("\n");
}
