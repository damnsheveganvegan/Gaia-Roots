// netlify/functions/get-products.js
//
// Runs on Netlify's servers only — never in the visitor's browser.
// Holds your Printify API token as a secret so it's never exposed to the public.
//
// Required environment variables (set in Netlify dashboard, NOT in this file):
//   PRINTIFY_API_TOKEN  - your Printify API access token
//   PRINTIFY_SHOP_ID    - your Printify shop ID
//
// How to get these:
//   1. Log into Printify -> My Account -> Connections -> Generate API token
//   2. Shop ID: call https://api.printify.com/v1/shops.json with that token,
//      or find it in your Printify shop URL/settings.

exports.handler = async function (event, context) {
  const SHOP_ID = process.env.PRINTIFY_SHOP_ID;
  const API_TOKEN = process.env.PRINTIFY_API_TOKEN;

  if (!SHOP_ID || !API_TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error:
          "Missing PRINTIFY_SHOP_ID or PRINTIFY_API_TOKEN environment variables in Netlify.",
      }),
    };
  }

  try {
    const response = await fetch(
      `https://api.printify.com/v1/shops/${SHOP_ID}/products.json`,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Printify API responded with ${response.status}`);
    }

    const data = await response.json();
    const rawProducts = Array.isArray(data.data) ? data.data : [];

    const products = rawProducts
      .filter((p) => p.visible) // only published/live products
      .map((p) => {
        // Pick the default image, falling back to the first available one.
        const mainImage =
          (p.images && (p.images.find((img) => img.is_default) || p.images[0]))
            ?.src || "";

        // Derive available sizes/colors and the lowest price from enabled variants.
        // Printify variant titles are usually formatted like "Black / M".
        const sizes = new Set();
        const colors = new Set();
        let minPriceCents = null;
        const variantIdToColor = {};

        (p.variants || []).forEach((v) => {
          if (!v.is_enabled) return;
          if (minPriceCents === null || v.price < minPriceCents) {
            minPriceCents = v.price;
          }
          const parts = String(v.title || "")
            .split("/")
            .map((s) => s.trim())
            .filter(Boolean);
          if (parts.length === 2) {
            colors.add(parts[0]);
            sizes.add(parts[1]);
            variantIdToColor[v.id] = parts[0];
          } else if (parts.length === 1) {
            sizes.add(parts[0]);
          }
        });

        // Group mockup images by color, so the front-end can show a
        // clickable swatch/thumbnail per color option. Each Printify image
        // lists which variant IDs it applies to; we use that to map an
        // image back to a color name. First matching image per color wins
        // (usually the front-facing mockup).
        const imagesByColor = {};
        (p.images || []).forEach((img) => {
          if (!img.src || !Array.isArray(img.variant_ids)) return;
          for (const vid of img.variant_ids) {
            const color = variantIdToColor[vid];
            if (color && !imagesByColor[color]) {
              imagesByColor[color] = img.src;
              break;
            }
          }
        });

        // Per-variant pricing (e.g. 2XL+ often costs more than S-XL).
        // Keyed the same way as variant titles: "Color / Size" or just
        // "Size" when there's only one color, so the front-end can look
        // up the exact price for whatever the customer picks.
        const variantPrices = {};
        (p.variants || []).forEach((v) => {
          if (!v.is_enabled) return;
          variantPrices[String(v.title).trim()] = Number((v.price / 100).toFixed(2));
        });

        // General gallery fallback (deduped) in case color mapping comes
        // back empty for a product with only one color.
        const gallery = Array.from(
          new Set((p.images || []).map((img) => img.src).filter(Boolean))
        ).slice(0, 8);

        // Strip HTML tags Printify sometimes includes in descriptions.
        const cleanDescription = (p.description || "")
          .replace(/<[^>]*>/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);

        return {
          id: p.id,
          title: p.title,
          description: cleanDescription,
          price: minPriceCents !== null ? (minPriceCents / 100).toFixed(2) : "0.00",
          image: mainImage,
          sizes: Array.from(sizes),
          colors: Array.from(colors),
          imagesByColor,
          gallery,
          variantPrices,
        };
      });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300", // 5 min edge cache
      },
      body: JSON.stringify(products),
    };
  } catch (error) {
    console.error("Error fetching Printify products:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch products from Printify." }),
    };
  }
};
