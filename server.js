const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 3000;

app.use(express.json());

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

/** Auth middleware - interroge Authelia via /api/verify */
async function checkAuth(req, res, next) {
  try {
    const cookies = req.headers.cookie;
    if (!cookies) return res.status(401).json({ error: 'Non authentifié (pas de cookies)' });
    console.log('Vérification des cookies :', cookies);
    const response = await axios.post('https://oauth2.croci-monteiro.fr/api/verify', {}, {
      headers: { Cookie: cookies },
      withCredentials: true,
    });
    console.log('Réponse d\'Authelia :', response);
    
    const headers = response.headers;

    const username = headers['remote-user'];
    if (!username) return res.status(401).json({ error: 'Non authentifié' });

    const users = loadUsers();

    // Met à jour ou crée l'utilisateur dans le JSON local
    users[username] = {
    email: headers['remote-email'] || null,
    displayName: headers['remote-name'] || null,
    groups: headers['remote-groups']?.split(',') || [],
    };
    saveUsers(users);

    req.userInfo = { username, ...users[username] };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Accès refusé par Authelia', details: error?.response?.data });
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
  servers: [{ url: 'https://localhost:3000' }, { url: 'https://api-myapp-oauth2.croci-monteiro.fr' }],
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
  const userGroups = req.userInfo.groups || [];
  // Retourne uniquement les services où au moins un groupe de l'user est autorisé
  const filteredServices = services.filter(s => 
    s.allowedGroups?.some(g => userGroups.includes(g))
  );
  res.json(filteredServices);
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
    console.log(`Utilisateur connecté : ${username}, Admin : ${isAdmin}`);
  res.json({ username, displayName, email, isAdmin });
});
