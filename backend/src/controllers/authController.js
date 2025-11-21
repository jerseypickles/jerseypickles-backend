// backend/src/controllers/authController.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

class AuthController {
  
  // Registrar usuario (solo para setup inicial)
  async register(req, res) {
    try {
      const { email, password, firstName, lastName } = req.body;
      
      // Validar datos requeridos
      if (!email || !password) {
        return res.status(400).json({ error: 'Email y password son requeridos' });
      }
      
      // Verificar si ya existe
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ error: 'El usuario ya existe' });
      }
      
      // Crear usuario
      const user = await User.create({
        email,
        password,
        firstName,
        lastName,
        role: 'admin' // Primer usuario es admin
      });
      
      // Generar token
      const token = jwt.sign(
        { userId: user._id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );
      
      res.status(201).json({
        token,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role
        }
      });
      
    } catch (error) {
      console.error('Error en registro:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Login
  async login(req, res) {
    try {
      const { email, password } = req.body;
      
      // VALIDACIÓN: Verificar que vengan los datos
      if (!email || !password) {
        return res.status(400).json({ error: 'Email y password son requeridos' });
      }
      
      console.log('Login attempt for:', email);
      
      // Buscar usuario con password
      const user = await User.findOne({ email }).select('+password');
      
      if (!user) {
        console.log('User not found:', email);
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
      
      // VALIDACIÓN CRÍTICA: Verificar que el password hasheado existe
      if (!user.password) {
        console.error('Password hash missing for user:', email);
        return res.status(500).json({ error: 'Error en la configuración del usuario. Contacte al administrador.' });
      }
      
      console.log('User found, comparing passwords...');
      
      // Verificar password
      const isMatch = await user.comparePassword(password);
      
      if (!isMatch) {
        console.log('Password mismatch for:', email);
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
      
      console.log('Login successful for:', email);
      
      // Actualizar último login (sin select para evitar problemas)
      await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });
      
      // Generar token
      const token = jwt.sign(
        { userId: user._id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );
      
      res.json({
        token,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role
        }
      });
      
    } catch (error) {
      console.error('Error en login:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener usuario actual
  async me(req, res) {
    try {
      const user = await User.findById(req.userId);
      
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      
      res.json({
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role
      });
      
    } catch (error) {
      console.error('Error obteniendo usuario:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new AuthController();