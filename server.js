const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const axios = require('axios');
const crypto = require('crypto');
const { auth } = require('express-openid-connect');
require('dotenv').config();
const cors = require('cors');

// Activer les logs détaillés pour debugging OIDC
process.env.DEBUG = 'express-openid-connect:*';

const app = express();
const PORT = process.env.PORT || 3000;

const corsOptions = {
  origin: process.env.CORS_ORIGIN,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json());

// Configuration pour proxy de confiance (derrière reverse proxy)
app.set('trust proxy', 1);

// Middleware de logging pour toutes les requêtes
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Logger la requête entrante
  console.log(`\n➡️  [${new Date().toISOString()}] [${requestId}]`);
  console.log(`   Méthode: ${req.method}`);
  console.log(`   Path: ${req.path}`);
  console.log(`   User: ${req.oidc?.user?.email || req.userInfo?.username || 'Non authentifié'}`);
  
  // Intercepter la réponse
  const originalJson = res.json;
  res.json = function(data) {
    const duration = Date.now() - startTime;
    
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log(`✅ [${requestId}] Succès ${res.statusCode} - ${req.method} ${req.path} (${duration}ms)`);
    } else if (res.statusCode >= 400) {
      console.error(`❌ [${requestId}] Erreur ${res.statusCode} - ${req.method} ${req.path} (${duration}ms)`);
      console.error(`   Détails:`, data);
    }
    
    return originalJson.call(this, data);
  };
  
  next();
});

// Configuration OIDC avec Authentik
console.log('🔧 Configuration OIDC:');
console.log('   BASE_URL:', process.env.BASE_URL);
console.log('   CORS_ORIGIN:', process.env.CORS_ORIGIN);
console.log('   AUTHENTIK_ISSUER:', process.env.AUTHENTIK_ISSUER);

const oidcConfig = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.SESSION_SECRET,
  baseURL: process.env.BASE_URL,
  clientID: process.env.AUTHENTIK_CLIENT_ID,
  clientSecret: process.env.AUTHENTIK_CLIENT_SECRET,
  issuerBaseURL: process.env.AUTHENTIK_ISSUER,
  authorizationParams: {
    response_type: 'code',
    scope: 'openid profile email groups',
  },
  routes: {
    callback: '/callback',
    login: '/login',
    logout: '/logout',
    postLogoutRedirect: process.env.CORS_ORIGIN,
  },
  session: {
    cookie: {
      httpOnly: true,
      secure: true, // Toujours sécurisé en HTTPS
      sameSite: 'None', // Permet les requêtes cross-site (API et frontend sur domaines différents)
      domain: '.oauth2.croci-monteiro.fr', // Cookie partagé entre tous les sous-domaines *.oauth2.croci-monteiro.fr
    },
    rolling: true,
    rollingDuration: 24 * 60 * 60, // 24 heures
  },
  afterCallback: async (req, res, session) => {
    // Après le callback réussi, rediriger vers le frontend
    console.log('✅ Callback OIDC réussi, session créée pour:', session.claims?.email || session.claims?.sub);
    return {
      ...session,
      returnTo: process.env.CORS_ORIGIN,
    };
  },
};

// Appliquer le middleware auth une seule fois
app.use(auth(oidcConfig));

// Middleware spécifique pour gérer les erreurs de callback
app.use((err, req, res, next) => {
  if (err && err.name === 'BadRequestError' && req.path === '/callback') {
    console.error('❌ Erreur interceptée au callback:');
    console.error('   Message:', err.message);
    console.error('   URL:', req.url);
    
    // Rediriger vers le frontend avec erreur
    return res.redirect(`${process.env.CORS_ORIGIN}?auth_error=${encodeURIComponent('Authentication failed')}`);
  }
  next(err);
});

const uploadFolder = './uploads';
if (!fs.existsSync(uploadFolder)) fs.mkdirSync(uploadFolder);

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Chemin vers dossier data (persistant)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Fichiers JSON
const USERS_FILE = path.join(dataDir, 'users.json');
const SERVICES_FILE = path.join(dataDir, 'services.json');
const MESSAGES_FILE = path.join(dataDir, 'messages.json');
const FAVORITES_FILE = path.join(dataDir, 'favorites.json');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadServices() {
  try {
    return JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveServices(services) {
  fs.writeFileSync(SERVICES_FILE, JSON.stringify(services, null, 2));
}

function loadMessages() {
  try {
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

function loadFavorites() {
  try {
    return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveFavorites(favorites) {
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favorites, null, 2));
}

/** Génère l'URL Gravatar depuis l'email */
function getGravatarUrl(email) {
  if (!email) return null;
  const hash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=200`;
}

/** Auth middleware - vérifie l'authentification OIDC */
function checkAuth(req, res, next) {
  if (!req.oidc.isAuthenticated()) {
    return res.status(401).json({ error: 'Non authentifié' });
  }

  try {
    const oidcUser = req.oidc.user;
    const username = oidcUser.email || oidcUser.sub;
    const users = loadUsers();
    
    const email = oidcUser.email || null;
    const displayName = oidcUser.name || oidcUser.preferred_username || null;
    const groups = oidcUser.groups || [];
    
    // Générer l'URL Gravatar
    const avatarUrl = getGravatarUrl(email);

    // Met à jour ou crée l'utilisateur dans le JSON local
    users[username] = {
      email,
      displayName,
      avatarUrl,
      groups,
    };
    saveUsers(users);

    req.userInfo = { username, ...users[username] };
    next();
  } catch (error) {
    console.error('❌ Erreur auth:', error.message);
    return res.status(500).json({ error: 'Erreur lors de la récupération des informations utilisateur', details: error.message });
  }
}

/** Middleware pour vérifier que l'utilisateur est admin */
function requireAdmin(req, res, next) {
  if (!req.userInfo?.groups?.includes('admin')) {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }
  next();
}

// Chargement initial des services
let services = loadServices();

/**
 * Swagger configuration
 */
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Service API',
    version: '1.0.0',
    description: 'API pour gérer des services avec image et redirection, accès contrôlé par groupes.',
  },
  servers: [{ url: `http://localhost:${PORT}` }, { url: process.env.BASE_URL }],
  components: {
    securitySchemes: {
      RemoteUserAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'remote-user',
      },
    },
  },
  security: [{ RemoteUserAuth: [] }],
};

const swaggerSpec = swaggerJsdoc({
  swaggerDefinition,
  apis: [__filename],
});

if (process.env.NODE_ENV === 'development') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  console.log('Swagger UI activé en mode développement');
} else {
  console.log('Swagger UI désactivé en production');
}

app.use('/uploads', express.static(uploadFolder));

// Route /whoami pour obtenir les infos utilisateur
app.get('/whoami', checkAuth, (req, res) => {
  try {
    const isAdmin = req.userInfo.groups?.includes('admin') || false;
    console.log(`👤 Whoami: ${req.userInfo.username}, Admin: ${isAdmin}`);
    
    res.json({
      username: req.userInfo.username,
      displayName: req.userInfo.displayName || req.userInfo.username,
      email: req.userInfo.email || null,
      avatarUrl: req.userInfo.avatarUrl || null,
      isAdmin,
    });
  } catch (error) {
    console.error('❌ Erreur /whoami:', error.message);
    res.status(500).json({ error: 'Erreur lors de la récupération des informations utilisateur' });
  }
});

/**
 * @swagger
 * /services:
 *   get:
 *     summary: Liste les services accessibles pour l'utilisateur selon ses groupes
 *     security:
 *       - RemoteUserAuth: []
 *     responses:
 *       200:
 *         description: Liste des services filtrée selon les groupes
 */
app.get('/services', checkAuth, (req, res) => {
  try {
    const userGroups = req.userInfo.groups || [];
    console.log(`🔍 Filtrage services pour groupes: [${userGroups.join(', ')}]`);
    
    // Retourne uniquement les services où au moins un groupe de l'user est autorisé
    const filteredServices = services.filter(s => 
      s.allowedGroups?.some(g => userGroups.includes(g))
    );
    
    console.log(`   → ${filteredServices.length} service(s) accessible(s)`);
    res.json(filteredServices);
  } catch (error) {
    console.error('❌ Erreur /services:', error.message);
    res.status(500).json({ error: 'Erreur lors de la récupération des services' });
  }
});

/**
 * @swagger
 * /add-service:
 *   post:
 *     summary: Ajouter un nouveau service (admin uniquement)
 *     security:
 *       - RemoteUserAuth: []
 *     consumes:
 *       - multipart/form-data
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               redirectUrl:
 *                 type: string
 *               groups:
 *                 type: array
 *                 items:
 *                   type: string
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Service ajouté
 */
app.post('/add-service', checkAuth, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, redirectUrl, groups } = req.body;
    const allowedGroups = Array.isArray(groups) ? groups : typeof groups === 'string' ? [groups] : [];
    const imageBuffer = req.file?.buffer;

    if (!name || !redirectUrl || !imageBuffer || allowedGroups.length === 0) {
      return res.status(400).json({ error: 'Champs manquants ou groupes non spécifiés' });
    }

    // Lire les métadonnées de l’image
    const metadata = await sharp(imageBuffer).metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;

    const resizedHeight = 50;
    const resizedWidth = Math.round((originalWidth / originalHeight) * resizedHeight);

    const resizedBuffer = await sharp(imageBuffer)
      .resize({ height: resizedHeight })
      .png()
      .toBuffer();

    const fileName = `${Date.now()}-${name.replace(/\s+/g, '_')}.png`;
    const filePath = path.join(uploadFolder, fileName);
    fs.writeFileSync(filePath, resizedBuffer);

    const newService = {
      id: Date.now().toString(),
      name,
      redirectUrl,
      allowedGroups,
      imagePath: filePath,
      originalWidth,
      originalHeight,
      resizedHeight,
      resizedWidth,
    };

    services.push(newService);
    saveServices(services);
    res.status(201).json({ service_id: newService.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de l’ajout' });
  }
});

/**
 * @swagger
 * /update-service/{id}:
 *   put:
 *     summary: Modifier un service existant (admin uniquement)
 *     security:
 *       - RemoteUserAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     consumes:
 *       - multipart/form-data
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               redirectUrl: { type: string }
 *               groups:
 *                 type: array
 *                 items:
 *                   type: string
 *               image: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Service modifié
 */
app.put('/update-service/:id', checkAuth, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const id = req.params.id;
    const index = services.findIndex(s => s.id === id);
    if (index === -1) return res.status(404).json({ error: 'Service introuvable' });

    const { name, redirectUrl, groups } = req.body;
    if (name) services[index].name = name;
    if (redirectUrl) services[index].redirectUrl = redirectUrl;
    if (groups) {
      const allowedGroups = Array.isArray(groups) ? groups : typeof groups === 'string' ? [groups] : [];
      if (allowedGroups.length) services[index].allowedGroups = allowedGroups;
    }

    if (req.file?.buffer) {
      const imageBuffer = req.file.buffer;
      const original = await sharp(imageBuffer).metadata();
      const resizedImageBuffer = await sharp(imageBuffer).resize({ height: 50 }).toBuffer();
      const fileName = `${Date.now()}-${services[index].name.replace(/\s+/g, '_')}.png`;
      const filePath = path.join(uploadFolder, fileName);

      fs.writeFileSync(filePath, resizedImageBuffer);

      // Supprime l'ancienne image
      if (fs.existsSync(services[index].imagePath)) {
        fs.unlinkSync(services[index].imagePath);
      }

      services[index].imagePath = filePath;
      services[index].originalWidth = original.width;
      services[index].originalHeight = original.height;
      services[index].resizedHeight = 50;
      services[index].resizedWidth = Math.round((original.width / original.height) * 50);
    }

    saveServices(services);
    res.json(services[index]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la modification' });
  }
});

/**
 * @swagger
 * /delete-service/{id}:
 *   delete:
 *     summary: Supprimer un service (admin uniquement)
 *     security:
 *       - RemoteUserAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Service supprimé
 */
app.delete('/delete-service/:id', checkAuth, requireAdmin, (req, res) => {
  const id = req.params.id;
  const index = services.findIndex(s => s.id === id);
  if (index === -1) return res.status(404).json({ error: 'Service introuvable' });

  const [removed] = services.splice(index, 1);
  if (fs.existsSync(removed.imagePath)) fs.unlinkSync(removed.imagePath);

  saveServices(services);
  res.json({ status: 'supprimé', id });
});

// Gestionnaire d'erreur global pour les erreurs OIDC
app.use((err, req, res, next) => {
  if (err.name === 'BadRequestError' && err.message.includes('invalid_grant')) {
    console.error('❌ Erreur OIDC invalid_grant:');
    console.error('   URL de callback:', req.url);
    console.error('   Cookies présents:', req.headers.cookie ? 'Oui' : 'Non');
    console.error('   Détails:', err.message);
    
    // Rediriger vers le frontend avec un message d'erreur
    return res.redirect(`${process.env.CORS_ORIGIN}?auth_error=invalid_grant`);
  }
  
  // Autres erreurs
  console.error('❌ Erreur serveur:', err);
  res.status(err.status || 500).json({ 
    error: err.message || 'Erreur interne du serveur' 
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
  console.log(`📚 Swagger docs : http://localhost:${PORT}/api-docs`);
});

/**
 * @swagger
 * /whoami:
 *   get:
 *     summary: Récupère les infos de l'utilisateur connecté (admin ou non)
 *     security:
 *       - RemoteUserAuth: []
 *     responses:
 *       200:
 *         description: Infos utilisateur
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 username:
 *                   type: string
 *                 isAdmin:
 *                   type: boolean
 */
app.get('/whoami', checkAuth, (req, res) => {
  const username = req.userInfo.username;
  const displayName = req.userInfo.displayName || username;
  const email = req.userInfo.email || null;
  const isAdmin = req.userInfo.groups.includes('admin');
  res.json({ username, displayName, email, isAdmin });
});

/**
 * @swagger
 * /user-ids:
 *   get:
 *     summary: Récupère la liste de tous les utilisateurs (admin uniquement)
 *     security:
 *       - RemoteUserAuth: []
 *     responses:
 *       200:
 *         description: Liste des utilisateurs avec id, email, displayName et groupes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     description: Email de l'utilisateur
 *                   email:
 *                     type: string
 *                   displayName:
 *                     type: string
 *                   groups:
 *                     type: array
 *                     items:
 *                       type: string
 */

/**
 * @swagger
 * /add-message:
 *   post:
 *     summary: Ajouter un nouveau message pour un ou plusieurs utilisateurs (admin uniquement)
 *     security:
 *       - RemoteUserAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - type
 *               - title
 *               - content
 *             properties:
 *               userId:
 *                 oneOf:
 *                   - type: string
 *                     description: Email d'un seul utilisateur destinataire
 *                   - type: array
 *                     items:
 *                       type: string
 *                     description: Array d'emails de plusieurs utilisateurs destinataires
 *               type:
 *                 type: string
 *                 enum: ['information', 'warning', 'error']
 *                 description: Type de message
 *               title:
 *                 type: string
 *                 description: Titre du message
 *               content:
 *                 type: string
 *                 description: Contenu du message
 *     responses:
 *       201:
 *         description: Message(s) créé(s) avec succès
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message_ids:
 *                   type: array
 *                   items:
 *                     type: string
 */

app.post('/add-message', checkAuth, requireAdmin, (req, res) => {
  try {
    const { userId, type, title, content } = req.body;
    
    if (!userId || !type || !title || !content) {
      return res.status(400).json({ error: 'Champs manquants (userId, type, title, content)' });
    }

    const validTypes = ['information', 'warning', 'error'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Type invalide. Doit être: information, warning ou error' });
    }

    // Convertir userId en array si c'est un string
    const userIds = Array.isArray(userId) ? userId : [userId];

    const messages = loadMessages();
    const messageIds = [];

    // Créer un message pour chaque utilisateur
    userIds.forEach(email => {
      const newMessage = {
        id: Date.now().toString() + Math.random(),
        userId: email,
        type,
        title,
        content,
        createdAt: new Date().toISOString(),
        dismissed: false
      };
      messages.push(newMessage);
      messageIds.push(newMessage.id);
    });

    saveMessages(messages);
    res.status(201).json({ message_ids: messageIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de l\'ajout du message' });
  }
});

/**
 * @swagger
 * /messages:
 *   get:
 *     summary: Récupère les messages non supprimés pour l'utilisateur connecté
 *     security:
 *       - RemoteUserAuth: []
 *     responses:
 *       200:
 *         description: Liste des messages de l'utilisateur
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   userId:
 *                     type: string
 *                     description: Email destinataire
 *                   type:
 *                     type: string
 *                     enum: ['information', 'warning', 'error']
 *                   title:
 *                     type: string
 *                   content:
 *                     type: string
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *                   dismissed:
 *                     type: boolean
 */

app.get('/messages', checkAuth, (req, res) => {
  try {
    const userEmail = req.userInfo.username; // l'email de l'utilisateur
    const messages = loadMessages();
    
    // Retourne les messages de cet utilisateur qui ne sont pas dismissed
    const userMessages = messages.filter(m => m.userId === userEmail && !m.dismissed);
    
    res.json(userMessages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des messages' });
  }
});

/**
 * @swagger
 * /all-messages:
 *   get:
 *     summary: Récupère tous les messages non supprimés (admin uniquement)
 *     security:
 *       - RemoteUserAuth: []
 *     responses:
 *       200:
 *         description: Liste de tous les messages (admin uniquement)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   userId:
 *                     type: string
 *                     description: Email destinataire
 *                   type:
 *                     type: string
 *                     enum: ['information', 'warning', 'error']
 *                   title:
 *                     type: string
 *                   content:
 *                     type: string
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *                   dismissed:
 *                     type: boolean
 */

app.get('/all-messages', checkAuth, requireAdmin, (req, res) => {
  try {
    const messages = loadMessages();
    
    // Retourne tous les messages non supprimés (admin uniquement)
    const allMessages = messages.filter(m => !m.dismissed);
    
    res.json(allMessages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des messages' });
  }
});

/**
 * @swagger
 * /delete-message/{id}:
 *   delete:
 *     summary: Supprimer un message (admin uniquement)
 *     security:
 *       - RemoteUserAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: ID du message à supprimer
 *     responses:
 *       200:
 *         description: Message supprimé
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: ['supprimé']
 *                 id:
 *                   type: string
 */

app.delete('/delete-message/:id', checkAuth, requireAdmin, (req, res) => {
  try {
    const messageId = req.params.id;
    const messages = loadMessages();
    
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) {
      return res.status(404).json({ error: 'Message introuvable' });
    }

    const [removed] = messages.splice(index, 1);
    saveMessages(messages);
    res.json({ status: 'supprimé', id: messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la suppression du message' });
  }
});

/**
 * @swagger
 * /update-message/{id}:
 *   post:
 *     summary: Mettre à jour un message (admin uniquement)
 *     security:
 *       - RemoteUserAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: ID du message à modifier
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: ['information', 'warning', 'error']
 *               title:
 *                 type: string
 *               content:
 *                 type: string
 *               dismissed:
 *                 type: boolean
 *                 description: Marquer comme "ne plus afficher" (pour les messages information)
 *     responses:
 *       200:
 *         description: Message modifié
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 type:
 *                   type: string
 *                 title:
 *                   type: string
 *                 content:
 *                   type: string
 *                 dismissed:
 *                   type: boolean
 */

app.post('/update-message/:id', checkAuth, requireAdmin, (req, res) => {
  try {
    const messageId = req.params.id;
    const { type, title, content, dismissed } = req.body;
    const messages = loadMessages();

    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) {
      return res.status(404).json({ error: 'Message introuvable' });
    }

    if (type) messages[index].type = type;
    if (title) messages[index].title = title;
    if (content) messages[index].content = content;
    if (typeof dismissed === 'boolean') messages[index].dismissed = dismissed;

    saveMessages(messages);
    res.json(messages[index]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du message' });
  }
});

app.get('/user-ids', checkAuth, requireAdmin, (req, res) => {
  try {
    const users = loadUsers();
    
    // Retourne la liste des utilisateurs avec nom, prénom et email
    const userList = Object.entries(users).map(([username, userInfo]) => ({
      id: username, // l'email
      email: username,
      displayName: userInfo.displayName || username,
      groups: userInfo.groups || []
    }));

    res.json(userList);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des utilisateurs' });
  }
});

/**
 * @swagger
 * /add-favorite:
 *   post:
 *     summary: Ajouter un lien en favori pour l'utilisateur connecté
 *     security:
 *       - RemoteUserAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - url
 *               - title
 *             properties:
 *               url:
 *                 type: string
 *                 description: URL du lien à ajouter en favori
 *               title:
 *                 type: string
 *                 description: Titre du favori
 *     responses:
 *       201:
 *         description: Favori ajouté avec succès
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 */

app.post('/add-favorite', checkAuth, (req, res) => {
  try {
    const { url, title } = req.body;
    const userEmail = req.userInfo.username;

    if (!url || !title) {
      return res.status(400).json({ error: 'Champs manquants (url, title)' });
    }

    const favorites = loadFavorites();
    
    // Vérifier si le favori existe déjà pour cet utilisateur
    const exists = favorites.find(f => f.url === url && f.userId === userEmail);
    if (exists) {
      return res.status(400).json({ error: 'Ce lien est déjà en favori' });
    }

    const newFavorite = {
      url, // ID du favori
      title,
      userId: userEmail, // Rattaché à l'utilisateur
      createdAt: new Date().toISOString()
    };

    favorites.push(newFavorite);
    saveFavorites(favorites);
    res.status(201).json({ url: newFavorite.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de l\'ajout du favori' });
  }
});

/**
 * @swagger
 * /favorites:
 *   get:
 *     summary: Récupère les favoris de l'utilisateur connecté
 *     security:
 *       - RemoteUserAuth: []
 *     responses:
 *       200:
 *         description: Liste des favoris
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   url:
 *                     type: string
 *                   title:
 *                     type: string
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 */

app.get('/favorites', checkAuth, (req, res) => {
  try {
    const userEmail = req.userInfo.username;
    const favorites = loadFavorites();
    
    // Retourne uniquement les favoris de cet utilisateur
    const userFavorites = favorites.filter(f => f.userId === userEmail);
    
    res.json(userFavorites);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des favoris' });
  }
});

/**
 * @swagger
 * /delete-favorite/{id}:
 *   delete:
 *     summary: Supprimer un favori (l'id est l'URL du lien)
 *     security:
 *       - RemoteUserAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: URL du favori à supprimer
 *     responses:
 *       200:
 *         description: Favori supprimé
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: ['supprimé']
 *                 url:
 *                   type: string
 */

app.delete('/delete-favorite/:id', checkAuth, (req, res) => {
  try {
    const url = decodeURIComponent(req.params.id); // Décoder l'URL
    const userEmail = req.userInfo.username;
    const favorites = loadFavorites();
    
    const index = favorites.findIndex(f => f.url === url && f.userId === userEmail);
    if (index === -1) {
      return res.status(404).json({ error: 'Favori introuvable' });
    }

    const [removed] = favorites.splice(index, 1);
    saveFavorites(favorites);
    res.json({ status: 'supprimé', url: removed.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la suppression du favori' });
  }
});