const puppeteer = require("puppeteer");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function selectDropdownOption(page, selectSelector, optionText) {
  await page.waitForSelector(selectSelector, { visible: true, timeout: 15000 });
  
  // Get all options and find the one matching our text
  const selected = await page.evaluate((selector, text) => {
    const select = document.querySelector(selector);
    if (!select) return false;
    const options = Array.from(select.options);
    const match = options.find(o => o.text.toLowerCase().includes(text.toLowerCase()));
    if (match) {
      select.value = match.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return match.text;
    }
    return false;
  }, selectSelector, optionText);

  if (!selected) throw new Error(`Could not find option containing "${optionText}" in ${selectSelector}`);
  console.log(`✅ Selected: "${selected}"`);
  await new Promise(r => setTimeout(r, 2000)); // wait for next dropdown to load
}

async function run() {
  console.log("🚀 Starting appointment check...");
  
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    );

    // ── Step 1: Load instructions page and click PROCEED ──────────────────
    console.log("📄 Loading instructions page...");
    await page.goto("https://appointment.cgifrankfurt.gov.in/", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Find and click the PROCEED link
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const proceed = links.find(l => l.textContent.trim().toUpperCase().includes("PROCEED"));
      if (proceed) proceed.click();
    });
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
    console.log("✅ Clicked PROCEED →", page.url());

    // ── Step 2: Select 'Individual' as applicant type ──────────────────────
    console.log("👤 Selecting Individual...");
    await selectDropdownOption(page, "select[name*='type'], select#applicant_type, select", "Individual");

    // ── Step 3: Select 'Passport Service' as Service Category ─────────────
    console.log("📂 Selecting Passport Service...");
    // Try multiple possible selectors for the category dropdown
    const categorySelectors = [
      "select[name*='category']",
      "select#service_category",
      "select#category",
    ];
    for (const sel of categorySelectors) {
      try {
        await selectDropdownOption(page, sel, "Passport");
        break;
      } catch {
        continue;
      }
    }

    // ── Step 4: Select 'Police Clearance Certificate' as Service ──────────
    console.log("📋 Selecting Police Clearance Certificate...");
    const serviceSelectors = [
      "select[name*='service']",
      "select#service_id",
      "select#service",
    ];
    for (const sel of serviceSelectors) {
      try {
        await selectDropdownOption(page, sel, "Police Clearance");
        break;
      } catch {
        continue;
      }
    }

    // ── Step 5: Wait for calendar/date slots to appear ────────────────────
    console.log("📅 Waiting for appointment dates to load...");
    await new Promise(r => setTimeout(r, 3000));

    // Grab a screenshot + all visible text for Claude to analyze
    const screenshot = await page.screenshot({ encoding: "base64", fullPage: true });
    const pageText = await page.evaluate(() => document.body.innerText);

    await browser.close();

    // ── Step 6: Ask Claude to analyze the available slots ─────────────────
    console.log("🤖 Asking Claude to analyze the page...");
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: screenshot },
          },
          {
            type: "text",
            text: `This is the Indian Consulate Frankfurt appointment booking page after selecting:
- Applicant Type: Individual
- Service Category: Passport Service  
- Service: Police Clearance Certificate

Page text content:
${pageText}

Please analyze:
1. Are there ANY available appointment slots/dates visible?
2. What is the earliest available date?
3. What is the latest available date?

If slots ARE available: start your response with ALERT: then list the available dates.
If NO slots available: start with NO SLOTS AVAILABLE and explain what you see.
Be concise.`,
          },
        ],
      }],
    });

    const result = response.content[0].text;
    console.log("\n📊 Result:", result);
    console.log("\nChecked at:", new Date().toISOString());

    // Exit with error code to trigger GitHub email notification
    if (result.startsWith("ALERT:")) {
      console.log("\n🚨 NEW APPOINTMENT SLOTS FOUND! Check the website now:");
      console.log("👉 https://appointment.cgifrankfurt.gov.in/");
      process.exit(1);
    }

  } catch (err) {
    await browser.close();
    console.error("❌ Error:", err.message);
    process.exit(1); // also alert on errors so you know if the script breaks
  }
}

run();