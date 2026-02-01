// backend/src/services/shopifyService.js (ACTUALIZADO CON FLOWS)
const axios = require('axios');

class ShopifyService {
  constructor() {
    this.shopUrl = process.env.SHOPIFY_STORE_URL;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    this.apiVersion = '2024-01';
    this.baseUrl = `https://${this.shopUrl}/admin/api/${this.apiVersion}`;
  }

  getHeaders() {
    return {
      'X-Shopify-Access-Token': this.accessToken,
      'Content-Type': 'application/json'
    };
  }

  async getAllCustomers() {
    try {
      console.log('🔗 Conectando con Shopify...');
      console.log(`📍 Shop: ${this.shopUrl}`);
      
      const customers = [];
      let nextPageUrl = `${this.baseUrl}/customers.json?limit=250`;
      let pageCount = 0;
      
      while (nextPageUrl) {
        pageCount++;
        console.log(`📄 Obteniendo página ${pageCount}...`);
        
        const response = await axios.get(nextPageUrl, {
          headers: this.getHeaders()
        });
        
        const pageCustomers = response.data.customers;
        customers.push(...pageCustomers);
        
        console.log(`   ✅ ${pageCustomers.length} clientes en esta página (Total: ${customers.length})`);
        
        // Obtener siguiente página del header Link
        nextPageUrl = this.getNextPageUrl(response.headers.link);
        
        if (nextPageUrl) {
          console.log('   ⏳ Esperando 500ms antes de la siguiente página...');
          await this.delay(500);
        }
      }
      
      console.log(`\n🎉 Sincronización completa: ${customers.length} clientes obtenidos de Shopify`);
      return customers;
      
    } catch (error) {
      console.error('\n❌ ERROR obteniendo clientes de Shopify:');
      
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Message: ${error.response.data?.errors || error.response.statusText}`);
        
        if (error.response.status === 401) {
          console.error('\n🔐 Error de autenticación. Verifica:');
          console.error('   1. SHOPIFY_ACCESS_TOKEN es correcto');
          console.error('   2. El token tiene permisos de lectura para customers');
        }
        
        if (error.response.status === 404) {
          console.error('\n🏪 Error de tienda. Verifica:');
          console.error('   1. SHOPIFY_STORE_URL es correcto (sin https://)');
          console.error(`   2. URL actual: ${this.shopUrl}`);
        }
      } else if (error.request) {
        console.error('   No se recibió respuesta del servidor');
        console.error('   Verifica tu conexión a internet');
      } else {
        console.error('   Error:', error.message);
      }
      
      throw error;
    }
  }

  async getCustomerById(customerId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/customers/${customerId}.json`,
        { headers: this.getHeaders() }
      );
      return response.data.customer;
    } catch (error) {
      console.error('Error obteniendo cliente:', error.response?.data || error.message);
      throw error;
    }
  }

  async getCustomerOrders(customerId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/customers/${customerId}/orders.json`,
        { headers: this.getHeaders() }
      );
      return response.data.orders;
    } catch (error) {
      console.error('Error obteniendo órdenes:', error.response?.data || error.message);
      throw error;
    }
  }

  async getAllOrders(params = {}, maxPages = null) {
    try {
      console.log('🔗 Conectando con Shopify para obtener órdenes...');
      
      if (maxPages) {
        console.log(`⚠️  MODO DEBUG: Solo procesando ${maxPages} página(s)\n`);
      }
      
      const orders = [];
      const queryParams = new URLSearchParams({
        limit: 250,
        status: 'any',
        ...params
      }).toString();
      
      let nextPageUrl = `${this.baseUrl}/orders.json?${queryParams}`;
      let pageCount = 0;
      
      while (nextPageUrl) {
        pageCount++;
        
        if (maxPages && pageCount > maxPages) {
          console.log(`\n⚠️  Límite de ${maxPages} página(s) alcanzado. Deteniendo...\n`);
          break;
        }
        
        console.log(`📄 Obteniendo página ${pageCount} de órdenes...`);
        
        const response = await axios.get(nextPageUrl, {
          headers: this.getHeaders()
        });
        
        const pageOrders = response.data.orders;
        orders.push(...pageOrders);
        
        console.log(`   ✅ ${pageOrders.length} órdenes en esta página (Total: ${orders.length})`);
        
        nextPageUrl = this.getNextPageUrl(response.headers.link);
        
        if (nextPageUrl) {
          await this.delay(500);
        }
      }
      
      console.log(`\n🎉 Sincronización completa: ${orders.length} órdenes obtenidas`);
      return orders;
      
    } catch (error) {
      console.error('❌ Error obteniendo órdenes:', error.response?.data || error.message);
      throw error;
    }
  }

  async getProductById(productId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/products/${productId}.json`,
        { headers: this.getHeaders() }
      );
      return response.data.product;
    } catch (error) {
      console.error('Error obteniendo producto:', error.response?.data || error.message);
      throw error;
    }
  }

  // ✅ Crear Price Rule para descuentos
  async createPriceRule(data) {
    try {
      console.log(`💰 Creando price rule: ${data.title}`);
      console.log(`   Descuento: ${data.value}%`);
      console.log(`   Expira: ${new Date(data.ends_at).toLocaleDateString()}`);
      
      const response = await axios.post(
        `${this.baseUrl}/price_rules.json`,
        { price_rule: data },
        { headers: this.getHeaders() }
      );
      
      console.log(`✅ Price rule creado con ID: ${response.data.price_rule.id}`);
      return response.data.price_rule;
      
    } catch (error) {
      console.error('❌ Error creando price rule:');
      console.error('   Status:', error.response?.status);
      console.error('   Data:', JSON.stringify(error.response?.data, null, 2));
      
      if (error.response?.status === 403) {
        console.error('\n⚠️  ERROR DE PERMISOS:');
        console.error('   El Access Token necesita: write_price_rules');
        console.error('   Ve a: Shopify Admin > Apps > Tu App > Configuration');
      }
      
      throw error;
    }
  }

  // ✅ Crear Discount Code
  async createDiscountCode(priceRuleId, code) {
    try {
      console.log(`🎟️  Creando discount code: ${code}`);
      console.log(`   Para price rule ID: ${priceRuleId}`);
      
      const response = await axios.post(
        `${this.baseUrl}/price_rules/${priceRuleId}/discount_codes.json`,
        { 
          discount_code: { 
            code: code 
          } 
        },
        { headers: this.getHeaders() }
      );
      
      console.log(`✅ Discount code creado exitosamente: ${code}`);
      return response.data.discount_code;
      
    } catch (error) {
      console.error('❌ Error creando discount code:');
      console.error('   Status:', error.response?.status);
      console.error('   Data:', JSON.stringify(error.response?.data, null, 2));
      
      if (error.response?.data?.errors?.code) {
        console.error('   El código ya existe en Shopify');
      }
      
      throw error;
    }
  }

  // 🆕 ACTUALIZADO: Crear webhooks incluyendo los nuevos para flows
  async createWebhooks() {
    const webhooks = [
      // Webhooks existentes
      {
        topic: 'customers/create',
        address: `${process.env.APP_URL}/api/webhooks/customers/create`,
        format: 'json'
      },
      {
        topic: 'customers/update',
        address: `${process.env.APP_URL}/api/webhooks/customers/update`,
        format: 'json'
      },
      {
        topic: 'orders/create',
        address: `${process.env.APP_URL}/api/webhooks/orders/create`,
        format: 'json'
      },
      {
        topic: 'orders/updated',
        address: `${process.env.APP_URL}/api/webhooks/orders/update`,
        format: 'json'
      },
      
      // 🆕 NUEVOS WEBHOOKS PARA FLOWS
      {
        topic: 'orders/fulfilled',
        address: `${process.env.APP_URL}/api/webhooks/orders/fulfilled`,
        format: 'json'
      },
      {
        topic: 'orders/cancelled',
        address: `${process.env.APP_URL}/api/webhooks/orders/cancelled`,
        format: 'json'
      },
      {
        topic: 'orders/paid',
        address: `${process.env.APP_URL}/api/webhooks/orders/paid`,
        format: 'json'
      },
      {
        topic: 'checkouts/create',
        address: `${process.env.APP_URL}/api/webhooks/checkouts/create`,
        format: 'json'
      },
      {
        topic: 'checkouts/update',
        address: `${process.env.APP_URL}/api/webhooks/checkouts/update`,
        format: 'json'
      },
      {
        topic: 'products/update',
        address: `${process.env.APP_URL}/api/webhooks/products/update`,
        format: 'json'
      },
      {
        topic: 'refunds/create',
        address: `${process.env.APP_URL}/api/webhooks/refunds/create`,
        format: 'json'
      }
    ];

    const results = [];
    
    for (const webhook of webhooks) {
      try {
        const response = await axios.post(
          `${this.baseUrl}/webhooks.json`,
          { webhook },
          { headers: this.getHeaders() }
        );
        
        results.push({
          success: true,
          topic: webhook.topic,
          id: response.data.webhook.id
        });
        
        console.log(`✅ Webhook creado: ${webhook.topic}`);
        await this.delay(500);
        
      } catch (error) {
        // Si ya existe (422), no es error
        if (error.response?.status === 422 && 
            error.response?.data?.errors?.address?.[0]?.includes('for this topic has already been taken')) {
          console.log(`⏭️  Webhook ya existe: ${webhook.topic}`);
          results.push({
            success: true,
            topic: webhook.topic,
            exists: true
          });
        } else {
          results.push({
            success: false,
            topic: webhook.topic,
            error: error.response?.data || error.message
          });
          console.error(`❌ Error creando webhook ${webhook.topic}:`, error.response?.data);
        }
      }
    }
    
    return results;
  }

  async listWebhooks() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/webhooks.json`,
        { headers: this.getHeaders() }
      );
      return response.data.webhooks;
    } catch (error) {
      console.error('Error listando webhooks:', error.response?.data || error.message);
      throw error;
    }
  }

  async deleteWebhook(webhookId) {
    try {
      await axios.delete(
        `${this.baseUrl}/webhooks/${webhookId}.json`,
        { headers: this.getHeaders() }
      );
      console.log(`✅ Webhook eliminado: ${webhookId}`);
    } catch (error) {
      console.error('Error eliminando webhook:', error.response?.data || error.message);
      throw error;
    }
  }

  // 🆕 NUEVO: Agregar tag a cliente
  async addCustomerTag(customerId, tag) {
    try {
      const customer = await this.getCustomerById(customerId);
      
      const currentTags = customer.tags ? customer.tags.split(', ') : [];
      if (!currentTags.includes(tag)) {
        currentTags.push(tag);
      }
      
      const response = await axios.put(
        `${this.baseUrl}/customers/${customerId}.json`,
        {
          customer: {
            id: customerId,
            tags: currentTags.join(', ')
          }
        },
        { headers: this.getHeaders() }
      );
      
      console.log(`✅ Tag "${tag}" agregado al cliente ${customerId}`);
      return response.data.customer;
      
    } catch (error) {
      console.error(`Error agregando tag:`, error.response?.data || error.message);
      throw error;
    }
  }

  // 🆕 NUEVO: Remover tag de cliente
  async removeCustomerTag(customerId, tag) {
    try {
      const customer = await this.getCustomerById(customerId);
      
      const currentTags = customer.tags ? customer.tags.split(', ') : [];
      const newTags = currentTags.filter(t => t !== tag);
      
      const response = await axios.put(
        `${this.baseUrl}/customers/${customerId}.json`,
        {
          customer: {
            id: customerId,
            tags: newTags.join(', ')
          }
        },
        { headers: this.getHeaders() }
      );
      
      console.log(`✅ Tag "${tag}" removido del cliente ${customerId}`);
      return response.data.customer;
      
    } catch (error) {
      console.error(`Error removiendo tag:`, error.response?.data || error.message);
      throw error;
    }
  }

  getNextPageUrl(linkHeader) {
    if (!linkHeader) return null;
    
    const links = linkHeader.split(',');
    const nextLink = links.find(link => link.includes('rel="next"'));
    
    if (nextLink) {
      const match = nextLink.match(/<(.*)>/);
      return match ? match[1] : null;
    }
    
    return null;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  async testConnection() {
    try {
      console.log('🧪 Testeando conexión con Shopify...');
      console.log(`📍 Shop: ${this.shopUrl}`);
      
      const response = await axios.get(
        `${this.baseUrl}/shop.json`,
        { headers: this.getHeaders() }
      );
      
      console.log('✅ Conexión exitosa!');
      console.log(`🏪 Tienda: ${response.data.shop.name}`);
      console.log(`📧 Email: ${response.data.shop.email}`);
      
      return { success: true, shop: response.data.shop };
      
    } catch (error) {
      console.error('❌ Error de conexión:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }
// ✅ Crear descuento completo para SMS (Price Rule + Discount Code)
async createSmsDiscount(code, percentOff = 15, expirationDays = 30) {
  try {
    const endsAt = new Date();
    endsAt.setDate(endsAt.getDate() + expirationDays);
    
    // 1. Crear Price Rule
    const priceRule = await this.createPriceRule({
      title: `SMS Welcome - ${code}`,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: 'percentage',
      value: `-${percentOff}`,
      customer_selection: 'all',
      usage_limit: 1,
      once_per_customer: true,
      starts_at: new Date().toISOString(),
      ends_at: endsAt.toISOString()
    });
    
    // 2. Crear Discount Code
    const discountCode = await this.createDiscountCode(priceRule.id, code);
    
    return {
      success: true,
      priceRuleId: priceRule.id.toString(),
      discountCodeId: discountCode.id.toString(),
      code: code
    };
    
  } catch (error) {
    console.error('❌ Error creating SMS discount:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
  }
}

  /**
   * Get unfulfilled orders older than specified hours
   * @param {number} hoursOld - Minimum age of order in hours (default 72)
   * @param {number} limit - Max orders to return (default 50)
   */
  async getUnfulfilledOrders(hoursOld = 72, limit = 50) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setHours(cutoffDate.getHours() - hoursOld);

      console.log(`🔍 Fetching unfulfilled orders older than ${hoursOld} hours...`);
      console.log(`   Cutoff date: ${cutoffDate.toISOString()}`);

      // Shopify API query for unfulfilled orders
      const response = await axios.get(
        `${this.baseUrl}/orders.json`,
        {
          headers: this.getHeaders(),
          params: {
            fulfillment_status: 'unfulfilled',
            financial_status: 'paid',
            status: 'open',
            created_at_max: cutoffDate.toISOString(),
            limit: limit
          }
        }
      );

      const orders = response.data.orders || [];
      console.log(`   Found ${orders.length} unfulfilled orders older than ${hoursOld} hours`);

      return orders;

    } catch (error) {
      console.error('❌ Error fetching unfulfilled orders:', error.response?.data || error.message);
      throw error;
    }
  }

module.exports = new ShopifyService();