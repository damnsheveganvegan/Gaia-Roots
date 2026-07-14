// netlify/functions/product-validation.js
//
// Snipcart calls this before finalizing any checkout, to confirm each cart
// item's price/ID weren't tampered with in the browser (e.g. via dev tools).
// By default it does a plain, non-JavaScript fetch of each product's
// data-item-url and looks for the info printed directly in the HTML.
//
// This site loads T-shirt products dynamically via JavaScript (the live
// Printify feed), so that raw-HTML check can't find them. This endpoint
// solves that using Snipcart's "JSON crawler": every data-item-url on the
// site points here instead, and we return each product's real id/price as
// JSON. Docs: https://docs.snipcart.com/v3/setup/order-validation
//
// Required environment variables (already set for get-products.js):
//   PRINTIFY_API_TOKEN
//   PRINTIFY_SHOP_ID

// Non-Printify products (book, journal, and the static tee fallback cards)
// aren't part of the live feed, so they're listed here directly. Keep this
// in sync with prices/ids used elsewhere in index.html.
const STATIC_PRODUCTS = [
  { id: "soil-in-my-veins-book", price: 24.0 },
  { id: "grounded-journal", price: 24.0 },
  { id: "breathe-metamorphosis", price: 28.99 },
  { id: "compost-nature", price: 28.99 },
  { id: "soil-in-my-veins", price: 28.99 },
  { id: "if-i-must-break", price: 28.99 },
  { id: "daughters-of-the-storm", price: 32.5 },
  { id: "the-inheritance", price: 28.99 },
];

// Must exactly match the data-item-url used in index.html (relative form,
// per Snipcart's recommendation for single-page sites).
const VALIDATION_URL = "/.netlify/functions/product-validation";

exports.handler = async function () {
  const SHOP_ID = process.env.PRINTIFY_SHOP_ID;
  const API_TOKEN = process.env.PRINTIFY_API_TOKEN;

  let liveProducts = [];

  if (SHOP_ID && API_TOKEN) {
    try {
      const res = await fetch(
        `https://api.printify.com/v1/shops/${SHOP_ID}/products.json`,
        { headers: { Authorization: `Bearer ${API_TOKEN}` } }
      );
      if (res.ok) {
        const data = await res.json();
        liveProducts = (data.data || [])
          .filter((p) => p.visible)
          .map((p) => {
            const enabledPrices = (p.variants || [])
              .filter((v) => v.is_enabled)
              .map((v) => v.price);
            const minPriceCents = enabledPrices.length
              ? Math.min(...enabledPrices)
              : 0;
            return { id: p.id, price: Number((minPriceCents / 100).toFixed(2)) };
          });
      } else {
        console.error("product-validation: Printify responded", res.status);
      }
    } catch (err) {
      console.error("product-validation: failed to fetch Printify products", err);
    }
  }

  const all = [...liveProducts, ...STATIC_PRODUCTS].map((p) => ({
    id: p.id,
    price: p.price,
    url: VALIDATION_URL,
  }));

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=120",
    },
    body: JSON.stringify(all),
  };
};
