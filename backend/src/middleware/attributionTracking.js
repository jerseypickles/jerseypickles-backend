// backend/src/middleware/attributionTracking.js

/**
 * Middleware para gestionar cookies de atribución
 * Guarda campaignId y customerId cuando alguien hace clic en un email
 */

const ATTRIBUTION_COOKIE_NAME = 'jp_email_attribution';
const ATTRIBUTION_WINDOW_DAYS = 7; // Ventana de atribución: 7 días

class AttributionService {
  
  /**
   * Crear cookie de atribución cuando alguien hace clic en email
   */
  static setAttribution(res, campaignId, customerId) {
    const maxAge = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000; // 7 días en ms
    
    const attributionData = {
      campaignId,
      customerId,
      clickedAt: new Date().toISOString()
    };
    
    res.cookie(ATTRIBUTION_COOKIE_NAME, JSON.stringify(attributionData), {
      maxAge,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      domain: process.env.COOKIE_DOMAIN || undefined
    });
    
    console.log(`🍪 Attribution cookie set: Campaign ${campaignId}, Customer ${customerId}`);
  }
  
  /**
   * Leer cookie de atribución
   */
  static getAttribution(req) {
    const cookie = req.cookies?.[ATTRIBUTION_COOKIE_NAME];
    
    if (!cookie) {
      return null;
    }
    
    try {
      const data = JSON.parse(cookie);
      const clickedAt = new Date(data.clickedAt);
      const now = new Date();
      const daysSinceClick = (now - clickedAt) / (1000 * 60 * 60 * 24);
      
      // Verificar si está dentro de la ventana de atribución
      if (daysSinceClick > ATTRIBUTION_WINDOW_DAYS) {
        console.log(`⏰ Attribution expired: ${daysSinceClick.toFixed(1)} days old`);
        return null;
      }
      
      return {
        campaignId: data.campaignId,
        customerId: data.customerId,
        clickedAt: data.clickedAt,
        daysSinceClick: daysSinceClick.toFixed(1)
      };
      
    } catch (error) {
      console.error('Error parsing attribution cookie:', error);
      return null;
    }
  }
  
  /**
   * Limpiar cookie de atribución
   */
  static clearAttribution(res) {
    res.clearCookie(ATTRIBUTION_COOKIE_NAME);
    console.log('🧹 Attribution cookie cleared');
  }
}

module.exports = AttributionService;