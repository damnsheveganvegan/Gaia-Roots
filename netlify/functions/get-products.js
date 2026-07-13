export async function handler(event, context) {
  // Replace with your actual Printify Blueprint Shop ID
  const SHOP_ID = 'YOUR_PRINTIFY_SHOP_ID'; 
  
  try {
    const response = await fetch(`https://printify.com{SHOP_ID}/products.json`, {
      headers: {
        'Authorization': `Bearer ${process.env.PRINTIFY_TOKEN}`,
        'User-Agent': 'NetlifyServerlessFunction'
      }
    });

    if (!response.ok) {
      return { statusCode: response.status, body: 'Failed fetching from Printify' };
    }

    const data = await response.json();

    // Map Printify data layout to a simpler format for your HTML page
    const products = data.data.map(prod => ({
      id: prod.id,
      title: prod.title,
      description: prod.description,
      image: prod.images[0]?.src, // Safely grabs the first mockup image URL
      price: (prod.variants[0]?.price / 100).toFixed(2) // Formats price for Snipcart
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(products),
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
}
