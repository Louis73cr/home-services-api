/**
 * Cloudflare Worker pour l'API Home Services
 * Utilise Prisma avec PostgreSQL hébergé
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import crypto from 'crypto';

// Helper pour parser multipart/form-data
async function parseMultipartFormData(request) {
  const formData = await request.formData();
  const result = {};
  let file = null;

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      // Si c'est le champ "image", stocker le fichier
      if (key === 'image') {
        file = {
          name: value.name,
          type: value.type,
          buffer: await value.arrayBuffer(),
        };
      }
    } else {
      // Gérer les champs texte, y compris les tableaux comme "groups"
      if (key === 'groups' && typeof value === 'string') {
        // Si groups est une chaîne, la convertir en tableau
        result[key] = value.split(',').map(g => g.trim()).filter(g => g);
      } else {
        result[key] = value;
      }
    }
  }

  return { fields: result, file };
}

// Helper pour les réponses JSON avec CORS
function jsonResponse(data, status = 200, options = {}) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://myapp.oauth2.croci-monteiro.fr',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...options.headers,
  };

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// Helper pour les erreurs CORS
function corsResponse(options = {}) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': 'https://myapp.oauth2.croci-monteiro.fr',
      'Access-Control-Allow-Methods': 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...options.headers,
    },
  });
}

// Génère l'URL Gravatar depuis l'email
function getGravatarUrl(email) {
  if (!email) return null;
  const hash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=200`;
}

// Helper pour logger les requêtes
function logRequest(method, path, status, details = {}) {
  const timestamp = new Date().toISOString();
  const emoji = status >= 200 && status < 300 ? '✅' : status >= 400 ? '❌' : '➡️';
  
  console.log(`${emoji} [${timestamp}] ${method} ${path} - ${status}`);
  
  if (details.user) {
    console.log(`   User: ${details.user}`);
  }
  
  if (details.error) {
    console.error(`   Erreur:`, details.error);
  }
  
  if (details.info) {
    console.log(`   Info:`, details.info);
  }
}

// Obtient une instance Prisma Client configurée pour Cloudflare Workers
function getPrisma(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  // Créer un pool de connexions PostgreSQL
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1, // Dans Workers, on limite à 1 connexion pour éviter les problèmes
  });

  // Créer l'adaptateur Prisma
  const adapter = new PrismaPg(pool);

  // Créer le client Prisma avec l'adaptateur
  const prisma = new PrismaClient({ adapter });

  return prisma;
}

// Middleware d'authentification - interroge Authentik via /api/verify
async function checkAuth(request, env) {
  const cookies = request.headers.get('cookie');
  if (!cookies) {
    return { error: 'Non authentifié (pas de cookies)', status: 401 };
  }

  try {
    const response = await fetch('https://oauth2.croci-monteiro.fr/api/verify', {
      method: 'POST',
      headers: {
        Cookie: cookies,
      },
    });

    if (!response.ok) {
      return { error: 'Accès refusé par Authentik', status: 401 };
    }

    const username = response.headers.get('remote-user');
    if (!username) {
      return { error: 'Non authentifié', status: 401 };
    }

    // Obtenir l'URL de la base de données depuis les variables d'environnement
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
      return { error: 'Configuration de base de données manquante', status: 500 };
    }

    const prisma = getPrisma(databaseUrl);

    try {
      // Chercher ou créer l'utilisateur dans la base de données
      const email = response.headers.get('remote-email') || null;
      const displayName = response.headers.get('remote-name') || null;
      
      // Récupérer les groupes depuis les headers Authentik
      // Authentik peut envoyer les groupes via 'remote-groups' ou 'x-authentik-groups'
      const groupsHeader = response.headers.get('remote-groups') || response.headers.get('x-authentik-groups') || '';
      const groups = groupsHeader.split(',').map(g => g.trim()).filter(g => g);
      
      // Générer l'URL Gravatar
      const avatarUrl = getGravatarUrl(email);

      const user = await prisma.user.upsert({
        where: { username },
        update: {
          email,
          displayName,
          avatarUrl,
          groups,
          updatedAt: new Date(),
        },
        create: {
          username,
          email,
          displayName,
          avatarUrl,
          groups,
        },
      });

      return {
        userInfo: {
          username: user.username,
          email: user.email,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          groups: user.groups,
        },
      };
    } finally {
      await prisma.$disconnect();
    }
  } catch (error) {
    console.error('Erreur d\'authentification:', error);
    return { error: 'Accès refusé par Authentik', status: 401, details: error.message };
  }
}

// Middleware pour vérifier que l'utilisateur est admin
function requireAdmin(userInfo) {
  if (!userInfo?.groups?.includes('admin')) {
    return { error: 'Accès réservé aux administrateurs', status: 403 };
  }
  return null;
}

// Traitement d'image simple
async function processImage(imageBuffer, imageName) {
  return {
    buffer: imageBuffer,
    fileName: `${Date.now()}-${imageName.replace(/\s+/g, '_')}.png`,
    originalWidth: null,
    originalHeight: null,
    resizedHeight: 50,
    resizedWidth: null,
  };
}

// Router principal
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    
    // Log de la requête entrante
    console.log(`\n➡️  [${new Date().toISOString()}] ${method} ${path}`);

    // Gestion CORS preflight
    if (method === 'OPTIONS') {
      logRequest(method, path, 204, { info: 'CORS preflight' });
      return corsResponse();
    }

    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
      logRequest(method, path, 500, { error: 'DATABASE_URL manquante' });
      return jsonResponse({ error: 'Configuration de base de données manquante' }, 500);
    }

    // Route: GET /whoami
    if (path === '/whoami' && method === 'GET') {
      const authResult = await checkAuth(request, env);
      if (authResult.error) {
        logRequest(method, path, authResult.status, { error: authResult.error });
        return jsonResponse({ error: authResult.error }, authResult.status);
      }

      const { userInfo } = authResult;
      const isAdmin = userInfo.groups.includes('admin');
      
      logRequest(method, path, 200, { 
        user: userInfo.username,
        info: `Admin: ${isAdmin}, Groupes: [${userInfo.groups.join(', ')}]`
      });
      
      return jsonResponse({
        username: userInfo.username,
        displayName: userInfo.displayName || userInfo.username,
        email: userInfo.email || null,
        avatarUrl: userInfo.avatarUrl || null,
        isAdmin,
      });
    }

    // Route: GET /services
    if (path === '/services' && method === 'GET') {
      const authResult = await checkAuth(request, env);
      if (authResult.error) {
        logRequest(method, path, authResult.status, { error: authResult.error });
        return jsonResponse({ error: authResult.error }, authResult.status);
      }

      const prisma = getPrisma(databaseUrl);
      try {
        const services = await prisma.service.findMany();
        const userGroups = authResult.userInfo.groups || [];
        
        console.log(`   Filtrage services pour groupes: [${userGroups.join(', ')}]`);
        
        // Filtrer les services selon les groupes de l'utilisateur
        const filteredServices = services.filter((s) =>
          s.allowedGroups.some((g) => userGroups.includes(g))
        );

        // Transformer les services pour l'API
        const servicesWithUrls = filteredServices.map((service) => {
          const serviceData = {
            id: service.id,
            name: service.name,
            redirectUrl: service.redirectUrl,
            allowedGroups: service.allowedGroups,
            imageUrl: service.imagePath ? `/images/${service.imagePath.replace('images/', '')}` : null,
            originalWidth: service.originalWidth,
            originalHeight: service.originalHeight,
            resizedHeight: service.resizedHeight,
            resizedWidth: service.resizedWidth,
            createdAt: service.createdAt,
            updatedAt: service.updatedAt,
          };
          return serviceData;
        });

        logRequest(method, path, 200, { 
          user: authResult.userInfo.username,
          info: `${filteredServices.length} service(s) accessible(s)`
        });
        
        return jsonResponse(servicesWithUrls);
      } catch (error) {
        console.error('Erreur lors de la récupération des services:', error);
        logRequest(method, path, 500, { error: error.message });
        return jsonResponse({ error: 'Erreur lors de la récupération des services' }, 500);
      } finally {
        await prisma.$disconnect();
      }
    }

    // Route: POST /add-service
    if (path === '/add-service' && method === 'POST') {
      const authResult = await checkAuth(request, env);
      if (authResult.error) {
        return jsonResponse({ error: authResult.error }, authResult.status);
      }

      const adminCheck = requireAdmin(authResult.userInfo);
      if (adminCheck) {
        return jsonResponse({ error: adminCheck.error }, adminCheck.status);
      }

      const prisma = getPrisma(databaseUrl);
      try {
        const { fields, file } = await parseMultipartFormData(request);
        const { name, redirectUrl, groups } = fields;
        const allowedGroups = Array.isArray(groups)
          ? groups
          : typeof groups === 'string'
          ? [groups]
          : [];

        if (!name || !redirectUrl || !file || allowedGroups.length === 0) {
          return jsonResponse(
            { error: 'Champs manquants ou groupes non spécifiés' },
            400
          );
        }

        const processedImage = await processImage(
          file.buffer,
          name.replace(/\s+/g, '_')
        );

        const imageKey = `images/${processedImage.fileName}`;
        
        // Sauvegarder l'image dans R2
        await env.IMAGES_R2.put(imageKey, processedImage.buffer, {
          httpMetadata: {
            contentType: 'image/png',
          },
        });

        // Créer le service dans la base de données
        const newService = await prisma.service.create({
          data: {
            name,
            redirectUrl,
            allowedGroups,
            imagePath: imageKey,
            originalWidth: processedImage.originalWidth,
            originalHeight: processedImage.originalHeight,
            resizedHeight: processedImage.resizedHeight,
            resizedWidth: processedImage.resizedWidth,
          },
        });

        return jsonResponse({ service_id: newService.id }, 201);
      } catch (error) {
        console.error('Erreur lors de l\'ajout du service:', error);
        return jsonResponse({ error: "Erreur lors de l'ajout" }, 500);
      } finally {
        await prisma.$disconnect();
      }
    }

    // Route: PUT /update-service/:id
    if (path.startsWith('/update-service/') && method === 'PUT') {
      const authResult = await checkAuth(request, env);
      if (authResult.error) {
        return jsonResponse({ error: authResult.error }, authResult.status);
      }

      const adminCheck = requireAdmin(authResult.userInfo);
      if (adminCheck) {
        return jsonResponse({ error: adminCheck.error }, adminCheck.status);
      }

      const prisma = getPrisma(databaseUrl);
      try {
        const id = path.split('/update-service/')[1];
        const existingService = await prisma.service.findUnique({
          where: { id },
        });

        if (!existingService) {
          return jsonResponse({ error: 'Service introuvable' }, 404);
        }

        const { fields, file } = await parseMultipartFormData(request);
        const { name, redirectUrl, groups } = fields;

        const updateData = {};
        if (name) updateData.name = name;
        if (redirectUrl) updateData.redirectUrl = redirectUrl;
        if (groups) {
          const allowedGroups = Array.isArray(groups)
            ? groups
            : typeof groups === 'string'
            ? [groups]
            : [];
          if (allowedGroups.length) {
            updateData.allowedGroups = allowedGroups;
          }
        }

        if (file) {
          const processedImage = await processImage(
            file.buffer,
            (name || existingService.name || 'service').replace(/\s+/g, '_')
          );

          const imageKey = `images/${processedImage.fileName}`;

          // Supprimer l'ancienne image de R2
          if (existingService.imagePath) {
            try {
              await env.IMAGES_R2.delete(existingService.imagePath);
            } catch (e) {
              console.error('Erreur lors de la suppression de l ancienne image:', e);
            }
          }

          // Sauvegarder la nouvelle image
          await env.IMAGES_R2.put(imageKey, processedImage.buffer, {
            httpMetadata: {
              contentType: 'image/png',
            },
          });

          updateData.imagePath = imageKey;
          updateData.originalWidth = processedImage.originalWidth;
          updateData.originalHeight = processedImage.originalHeight;
          updateData.resizedHeight = processedImage.resizedHeight;
          updateData.resizedWidth = processedImage.resizedWidth;
        }

        const updatedService = await prisma.service.update({
          where: { id },
          data: updateData,
        });

        return jsonResponse({
          id: updatedService.id,
          name: updatedService.name,
          redirectUrl: updatedService.redirectUrl,
          allowedGroups: updatedService.allowedGroups,
          imagePath: updatedService.imagePath,
          originalWidth: updatedService.originalWidth,
          originalHeight: updatedService.originalHeight,
          resizedHeight: updatedService.resizedHeight,
          resizedWidth: updatedService.resizedWidth,
        });
      } catch (error) {
        console.error('Erreur lors de la modification du service:', error);
        return jsonResponse({ error: 'Erreur lors de la modification' }, 500);
      } finally {
        await prisma.$disconnect();
      }
    }

    // Route: DELETE /delete-service/:id
    if (path.startsWith('/delete-service/') && method === 'DELETE') {
      const authResult = await checkAuth(request, env);
      if (authResult.error) {
        return jsonResponse({ error: authResult.error }, authResult.status);
      }

      const adminCheck = requireAdmin(authResult.userInfo);
      if (adminCheck) {
        return jsonResponse({ error: adminCheck.error }, adminCheck.status);
      }

      const prisma = getPrisma(databaseUrl);
      try {
        const id = path.split('/delete-service/')[1];
        const service = await prisma.service.findUnique({
          where: { id },
        });

        if (!service) {
          return jsonResponse({ error: 'Service introuvable' }, 404);
        }

        // Supprimer l'image de R2
        if (service.imagePath) {
          try {
            await env.IMAGES_R2.delete(service.imagePath);
          } catch (e) {
            console.error('Erreur lors de la suppression de l image:', e);
          }
        }

        // Supprimer le service de la base de données
        await prisma.service.delete({
          where: { id },
        });

        return jsonResponse({ status: 'supprimé', id });
      } catch (error) {
        console.error('Erreur lors de la suppression du service:', error);
        return jsonResponse({ error: 'Erreur lors de la suppression' }, 500);
      } finally {
        await prisma.$disconnect();
      }
    }

    // Route: GET /images/:key (pour servir les images depuis R2)
    if (path.startsWith('/images/') && method === 'GET') {
      try {
        const imageKey = path.replace('/images/', '');
        const object = await env.IMAGES_R2.get(`images/${imageKey}`);

        if (!object) {
          return new Response('Image non trouvée', { status: 404 });
        }

        return new Response(object.body, {
          headers: {
            'Content-Type': object.httpMetadata?.contentType || 'image/png',
            'Cache-Control': 'public, max-age=31536000',
            'Access-Control-Allow-Origin': 'https://myapp.oauth2.croci-monteiro.fr',
          },
        });
      } catch (err) {
        console.error(err);
        return new Response('Erreur lors de la récupération de l image', {
          status: 500,
        });
      }
    }

    // Route non trouvée
    return jsonResponse({ error: 'Route non trouvée' }, 404);
  },
};
