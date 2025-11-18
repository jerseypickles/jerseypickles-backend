// backend/src/services/shopifyService.js
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

  // 🔧 MODIFICADO: Ahora acepta maxPages para limitar las páginas
  async getAllOrders(params = {}, maxPages = null) {
    try {
      console.log('🔗 Conectando con Shopify para obtener órdenes...');
      
      // 🔍 NUEVO: Mostrar si hay límite de páginas
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
        
        // 🔍 NUEVO: Detener si alcanzamos el límite de páginas
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

  async createWebhooks() {
    const webhooks = [
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
        results.push({
          success: false,
          topic: webhook.topic,
          error: error.response?.data || error.message
        });
        console.error(`❌ Error creando webhook ${webhook.topic}:`, error.response?.data);
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
  
  // Método para testear conexión
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
}

module.exports = new ShopifyService();