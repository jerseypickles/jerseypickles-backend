// backend/src/routes/upload.js
const express = require('express');
const router = express.Router();
const cloudinary = require('../config/cloudinary');
const { protect } = require('../middleware/auth');

// Subir imagen desde base64
router.post('/image', protect, async (req, res) => {
  try {
    const { image, folder = 'campaigns' } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No se proporcionó imagen' });
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

    res.json({
      success: true,
      url: result.secure_url,
      public_id: result.public_id
    });

  } catch (error) {
    console.error('Error subiendo imagen:', error);
    res.status(500).json({ 
      error: 'Error subiendo imagen',
      details: error.message 
    });
  }
});

module.exports = router;