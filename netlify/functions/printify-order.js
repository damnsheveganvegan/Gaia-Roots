// netlify/functions/printify-order.js
//
// Listens for Snipcart's "order.completed" webhook, verifies it's really
// from Snipcart, then creates a matching order in Printify for fulfillment.

const productMap = {
  shop_id: 28189021,
  products: {
    'breathe-metamorphosis': {
      printify_product_id: '6a5303141e7f67c4f10ba979',
      colors: {
        'Military Green': { S: 12192, M: 12191, L: 12190, XL: 12193, '2XL': 12194, '3XL': 12195, '4XL': 24060, '5XL': 24194 },
        'Red':            { S: 12024, M: 12023, L: 12022, XL: 12025, '2XL': 12026, '3XL': 12027, '4XL': 24005, '5XL': 24138 },
      },
    },
    'compost-nature': {
      printify_product_id: '6a525464773bfedc8c0bcc88',
      colors: {
        'Forest Green': { S: 12144, M: 12143, L: 12142, XL: 12145, '2XL': 12146, '3XL': 12147, '4XL': 24045, '5XL': 24178 },
      },
    },
    'soil-in-my-veins': {
      printify_product_id: '6a522d54773bfedc8c0ba8b9',
      colors: {
        'White': { S: 12102, M: 12101, L: 12100, XL: 12103, '2XL': 12104, '3XL': 12105, '4XL': 24031, '5XL': 24164 },
      },
    },
    'if-i-must-break': {
      printify_product_id: '6a522c799e0882f544002d39',
      colors: {
        'Natural': { S: 11982, M: 11981, L: 11980, XL: 11983, '2XL': 11984, '3XL': 11985, '4XL': 23991, '5XL': 24124 },
      },
    },
    'daughters-of-the-storm': {
      printify_product_id: '6a52235c773bfedc8c0ba219',
      colors: {
        'Black': { S: 12126, M: 12125, L: 12124, XL: 12127, '2XL': 12128, '3XL': 12129, '4XL': 24039, '5XL': 24171 },
        'Navy':  { S: 11988, M: 11987, L: 11986, XL: 11989, '2XL': 11990, '3XL': 11991, '4XL': 23993, '5XL': 24126 },
        'Maroon':{ S: 11976, M: 11975, L: 11974, XL: 11977, '2XL': 11978, '3XL': 11979, '4XL': 23989, '5XL': 24122 },
      },
    },
    'the-inheritance': {
      printify_product_id: '6a521fb45a237ba6d60985f6',
      colors: {
        'Black': { S: 12126, M: 12125, L: 12124, XL: 12127, '2XL': 12128, '3XL': 12129, '4XL': 24039, '5XL': 24171 },
        'White': { S: 12102, M: 12101, L: 12100, XL: 12103, '2XL': 12104, '3XL': 12105, '4XL': 24031, '5XL': 24164 },
      },
    },
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // --- 1. Verify this request genuinely came from Snipcart ---
  const token = event.headers['x-snipcart-requesttoken'];
  if (!token) {
    return { statusCode: 401, body: 'Missing Snipcart request token' };
  }

  try {
    const verifyRes = await fetch(
      `https://app.snipcart.com/api/requestvalidation/${token}`,
      {
        headers: {
          Authorization:
            'Basic ' + Buffer.from(process.env.SNIPCART_SECRET_KEY + ':').toString('base64'),
        },
      }
    );
    if (!verifyRes.ok) {
      return { statusCode: 401, body: 'Invalid Snipcart request token' };
    }
  } catch (err) {
    console.error('Snipcart verification failed:', err);
    return { statusCode: 401, body: 'Could not verify Snipcart request' };
  }

  // --- 2. Only act on completed orders ---
  const payload = JSON.parse(event.body);
  if (payload.eventName !== 'order.completed') {
    return { statusCode: 200, body: 'Ignored (not an order.completed event)' };
  }

  const order = payload.content;

  // --- 3. Translate each Snipcart cart item into a Printify line item ---
  const lineItemsByProduct = {}; // group by printify_product_id since Printify orders are per-shop, multi-product is fine, but we validate per item

  const lineItems = [];
  for (const item of order.items) {
    const productKey = item.id; // must match a key in printify-product-map.json
    const product = productMap.products[productKey];

    if (!product) {
      console.error(`Unknown product key "${productKey}" — skipping item`);
      continue;
    }

    // Pull Size (and Color, if this product has more than one) from Snipcart's custom fields
    const customFields = item.customFields || [];
    const sizeField = customFields.find((f) => f.name === 'Size');
    const colorField = customFields.find((f) => f.name === 'Color');

    const size = sizeField ? sizeField.value : null;
    const colorNames = Object.keys(product.colors);
    const color = colorField ? colorField.value : colorNames[0]; // single-color products don't need a Color field

    const variantId = product.colors[color] && product.colors[color][size];

    if (!variantId) {
      console.error(
        `Could not resolve variant for "${productKey}" — color: ${color}, size: ${size}`
      );
      continue;
    }

    lineItems.push({
      product_id: product.printify_product_id,
      variant_id: variantId,
      quantity: item.quantity,
    });
  }

  if (lineItems.length === 0) {
    console.error('No valid line items resolved for order', order.invoiceNumber);
    return { statusCode: 400, body: 'No valid line items' };
  }

  // --- 4. Build the Printify order payload ---
  const shipTo = order.shippingAddress || {};
  const printifyOrder = {
    external_id: order.invoiceNumber || order.token,
    label: order.invoiceNumber,
    line_items: lineItems,
    shipping_method: 1, // standard shipping; Printify picks the cheapest eligible option
    send_shipping_notification: false,
    address_to: {
      first_name: shipTo.firstName || order.billingAddress?.firstName || '',
      last_name: shipTo.lastName || order.billingAddress?.lastName || '',
      email: order.email,
      phone: shipTo.phone || '',
      country: shipTo.country,
      region: shipTo.province || '',
      address1: shipTo.address1,
      address2: shipTo.address2 || '',
      city: shipTo.city,
      zip: shipTo.postalCode,
    },
  };

  // --- 5. Send it to Printify ---
  try {
    const printifyRes = await fetch(
      `https://api.printify.com/v1/shops/${productMap.shop_id}/orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.PRINTIFY_API_TOKEN}`,
        },
        body: JSON.stringify(printifyOrder),
      }
    );

    const result = await printifyRes.json();

    if (!printifyRes.ok) {
      console.error('Printify order creation failed:', result);
      return { statusCode: 502, body: JSON.stringify(result) };
    }

    console.log('Printify order created:', result.id);
    return { statusCode: 200, body: JSON.stringify({ success: true, printifyOrderId: result.id }) };
  } catch (err) {
    console.error('Error sending order to Printify:', err);
    return { statusCode: 500, body: 'Error sending order to Printify' };
  }
};
