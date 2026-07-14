// netlify/functions/printify-order.js
//
// Runs on Netlify's servers only. Snipcart calls this automatically whenever
// an order is completed on your site. This function:
//   1. Verifies the request genuinely came from Snipcart (not a forged call)
//   2. Reads the items that were purchased
//   3. Looks up the matching Printify product/variant (based on Size/Color
//      the customer chose)
//   4. Submits an order to Printify so it gets printed and shipped
//
// Required environment variables (Netlify dashboard -> Environment variables):
//   SNIPCART_SECRET_API_KEY  - Snipcart secret key (Snipcart dashboard -> Store config -> API Keys -> Secret key)
//   PRINTIFY_API_TOKEN       - same one used by get-products.js
//   PRINTIFY_SHOP_ID         - same one used by get-products.js
//
// Snipcart setup (in Snipcart dashboard -> Store config -> Webhooks):
//   Add a webhook for the "order.completed" event pointing to:
//   https://YOUR-SITE.netlify.app/.netlify/functions/printify-order
//
// IMPORTANT CAVEAT:
//   This only works correctly for products whose Snipcart item ID is a real
//   Printify product ID — meaning the product came from the live Printify
//   feed (get-products.js), not the static fallback cards or non-Printify
//   items like the book or journal. Non-Printify items are skipped here and
//   logged, so you know to fulfill them manually (as already planned for
//   the book, via your own Lulu account).

const PRINTIFY_API = "https://api.printify.com/v1";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const SNIPCART_SECRET = process.env.SNIPCART_SECRET_API_KEY;
  const PRINTIFY_TOKEN = process.env.PRINTIFY_API_TOKEN;
  const SHOP_ID = process.env.PRINTIFY_SHOP_ID;

  if (!SNIPCART_SECRET || !PRINTIFY_TOKEN || !SHOP_ID) {
    console.error("Missing required environment variables.");
    return { statusCode: 500, body: "Server not configured." };
  }

  // --- 1. Verify this request really came from Snipcart ---
  // Snipcart sends a one-time token in this header. We exchange it with
  // Snipcart's own API to confirm it's valid before trusting the payload.
  const token = event.headers["x-snipcart-requesttoken"];
  if (!token) {
    return { statusCode: 401, body: "Missing Snipcart request token." };
  }

  try {
    const verifyRes = await fetch(
      `https://app.snipcart.com/api/requestvalidation/${token}`,
      {
        headers: {
          Authorization:
            "Basic " + Buffer.from(SNIPCART_SECRET + ":").toString("base64"),
        },
      }
    );
    if (!verifyRes.ok) {
      return { statusCode: 401, body: "Invalid Snipcart request token." };
    }
  } catch (err) {
    console.error("Snipcart token validation failed:", err);
    return { statusCode: 401, body: "Could not validate request." };
  }

  // --- 2. Parse the webhook payload ---
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: "Invalid JSON payload." };
  }

  // Only act on completed orders; acknowledge and ignore everything else.
  if (payload.eventName !== "order.completed") {
    return { statusCode: 200, body: "Ignored event: " + payload.eventName };
  }

  const order = payload.content;

  try {
    const result = await submitOrderToPrintify(order, {
      PRINTIFY_TOKEN,
      SHOP_ID,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (err) {
    console.error("Failed to submit order to Printify:", err);
    // Return 200 anyway so Snipcart doesn't endlessly retry a failed
    // conversion it can't fix on its own; the real error is in the logs.
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

async function submitOrderToPrintify(order, { PRINTIFY_TOKEN, SHOP_ID }) {
  const headers = {
    Authorization: `Bearer ${PRINTIFY_TOKEN}`,
    "Content-Type": "application/json",
  };

  const lineItems = [];
  const skipped = [];

  for (const item of order.items || []) {
    // A real Printify product ID looks like a 24-character hex string
    // (Mongo-style ID). Anything else (e.g. "soil-in-my-veins-book") is a
    // non-Printify item — skip it and flag it for manual fulfillment.
    const looksLikePrintifyId = /^[a-f0-9]{20,24}$/i.test(item.id);
    if (!looksLikePrintifyId) {
      skipped.push(item.id);
      continue;
    }

    const size = getCustomField(item, "Size");
    const color = getCustomField(item, "Color");

    const variantId = await findVariantId(item.id, size, color, {
      PRINTIFY_TOKEN,
      SHOP_ID,
    });

    if (!variantId) {
      console.warn(
        `Could not match a Printify variant for item ${item.id} (Size: ${size}, Color: ${color}). Skipping.`
      );
      skipped.push(item.id);
      continue;
    }

    lineItems.push({
      product_id: item.id,
      variant_id: variantId,
      quantity: item.quantity || 1,
    });
  }

  if (lineItems.length === 0) {
    return { message: "No Printify-fulfillable items in this order.", skipped };
  }

  const shipping = order.shippingAddress || {};
  const nameParts = String(shipping.fullName || order.billingAddress?.fullName || "")
    .trim()
    .split(" ");
  const firstName = nameParts[0] || "Customer";
  const lastName = nameParts.slice(1).join(" ") || "-";

  const printifyOrderPayload = {
    external_id: order.token || order.invoiceNumber,
    label: order.invoiceNumber,
    line_items: lineItems,
    shipping_method: 1, // standard shipping; adjust in Printify if needed
    send_shipping_notification: true,
    address_to: {
      first_name: firstName,
      last_name: lastName,
      email: order.email,
      phone: shipping.phone || "",
      country: shipping.country || "",
      region: shipping.province || "",
      address1: shipping.address1 || "",
      address2: shipping.address2 || "",
      city: shipping.city || "",
      zip: shipping.postalCode || "",
    },
  };

  const res = await fetch(
    `${PRINTIFY_API}/shops/${SHOP_ID}/orders.json`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(printifyOrderPayload),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Printify order creation failed (${res.status}): ${errText}`);
  }

  const created = await res.json();
  return { message: "Order submitted to Printify.", printifyOrderId: created.id, skipped };
}

function getCustomField(item, name) {
  const field = (item.customFields || []).find((f) => f.name === name);
  return field ? field.value : null;
}

// Looks up a product's variants from Printify and finds the one matching
// the chosen Size/Color, using the same "Color / Size" title format
// get-products.js relies on.
async function findVariantId(productId, size, color, { PRINTIFY_TOKEN, SHOP_ID }) {
  const res = await fetch(
    `${PRINTIFY_API}/shops/${SHOP_ID}/products/${productId}.json`,
    {
      headers: { Authorization: `Bearer ${PRINTIFY_TOKEN}` },
    }
  );
  if (!res.ok) return null;

  const product = await res.json();
  const variants = product.variants || [];

  const target = color && size ? `${color} / ${size}` : size || color;

  const match = variants.find(
    (v) => v.is_enabled && String(v.title).trim() === String(target).trim()
  );
  return match ? match.id : null;
}
