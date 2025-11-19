// backend/src/routes/upload.js
const express = require('express');
const router = express.Router();
const cloudinary = require('../config/cloudinary');

// Subir imagen desde base64
router.post('/image', async (req, res) => {
  try {
    const { image, folder = 'campaigns' } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No se proporcionó imagen' });
    }

    // Validar que sea base64
    if (!image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Formato de imagen inválido' });
    }

    // Subir a Cloudinary
    const result = await cloudinary.uploader.upload(image, {
      folder: `jerseypickles/${folder}`,
      resource_type: 'auto',
      transformation: [
        { width: 800, crop: 'limit' },
        { quality: 'auto:good' }
      ]
    });

    console.log('✅ Imagen subida a Cloudinary:', result.secure_url);

    res.json({
      success: true,
      url: result.secure_url,
      public_id: result.public_id
    });

  } catch (error) {
    console.error('❌ Error subiendo imagen a Cloudinary:', error);
    res.status(500).json({ 
      error: 'Error subiendo imagen',
      details: error.message 
    });
  }
});

module.exports = router;