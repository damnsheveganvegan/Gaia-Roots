// netlify/functions/printify-order.js
//
// Listens for Snipcart's "order.completed" webhook, verifies it's really
// from Snipcart, then creates a matching order in Printify for fulfillment.

const productMap = require('./printify-product-map.json');

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
