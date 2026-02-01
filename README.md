# Home Services API - Cloudflare Workers/Pages

API pour gérer des services avec images et redirection, conçue pour fonctionner sur Cloudflare Workers ou Cloudflare Pages.

Utilise **Prisma** avec **PostgreSQL** hébergé pour le stockage des données et **Cloudflare R2** pour les images.

## 🚀 Déploiement

### Prérequis

1. Installer [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/):
```bash
npm install -g wrangler
```

2. Se connecter à Cloudflare:
```bash
wrangler login
```

### Configuration

#### 1. Base de données PostgreSQL

Assurez-vous d'avoir une base de données PostgreSQL hébergée et accessible depuis Internet.

1. Créez une base de données PostgreSQL:
```sql
CREATE DATABASE home_services;
```

2. Configurez la connexion dans `.env` (pour le développement local):
```bash
DATABASE_URL="postgresql://user:password@host:5432/home_services"
```

3. Générez le client Prisma et appliquez les migrations:
```bash
npm install
npm run db:generate
npm run db:push
```

#### 2. Configurer DATABASE_URL dans Cloudflare

**Pour Cloudflare Workers:**
```bash
wrangler secret put DATABASE_URL
# Entrez votre URL de connexion PostgreSQL quand demandé
```

**Pour Cloudflare Pages:**
- Allez dans le dashboard Cloudflare > Pages > Votre projet > Settings > Environment variables
- Ajoutez `DATABASE_URL` comme variable secrète

#### 3. Créer le bucket R2

```bash
wrangler r2 bucket create images-bucket
```

Mettez à jour `bucket_name` dans `wrangler.toml` si vous choisissez un autre nom.

#### 4. Configurer wrangler.toml

Éditez `wrangler.toml` et:
- Ajustez `bucket_name` si vous avez choisi un autre nom pour votre bucket R2
- Les variables d'environnement sont configurées via les secrets Cloudflare (voir étape 2)

### Déploiement

#### Option 1: Cloudflare Workers

```bash
# Installation des dépendances
npm install

# Développement local
npm run dev

# Déploiement
npm run deploy
```

#### Option 2: Cloudflare Pages

Le fichier `functions/api/[[path]].js` est déjà configuré pour Cloudflare Pages Functions.

1. Configurez les bindings R2 dans le dashboard Cloudflare Pages:
   - Allez dans Pages > Votre projet > Settings > Functions
   - Ajoutez un binding R2 avec le nom `IMAGES_R2`

2. Configurez la variable `DATABASE_URL` comme secret (voir étape 2 ci-dessus)

3. Déployez:
```bash
npm run pages:deploy
```

## 📝 Notes importantes

### Différences avec l'API Express originale

1. **Stockage**: Utilise **Prisma avec PostgreSQL** au lieu de fichiers JSON
2. **Images**: Utilise Cloudflare R2 au lieu du système de fichiers
3. **Traitement d'images**: Voir section "Traitement d'images" ci-dessous
4. **Authentification**: Identique (interroge Authentik via /api/verify)

### Routes disponibles

- `GET /whoami` - Récupère les infos de l'utilisateur connecté
- `GET /services` - Liste les services accessibles pour l'utilisateur
- `POST /add-service` - Ajoute un nouveau service (admin uniquement)
- `PUT /update-service/:id` - Modifie un service existant (admin uniquement)
- `DELETE /delete-service/:id` - Supprime un service (admin uniquement)
- `GET /images/:key` - Sert les images depuis R2

### Variables d'environnement

Les variables d'environnement peuvent être configurées via:

**Pour le développement local:**
- Créez un fichier `.env` à la racine du projet:
```bash
DATABASE_URL="postgresql://user:password@host:5432/database"
```

**Pour la production (Cloudflare):**
- Utilisez les secrets Cloudflare (recommandé pour `DATABASE_URL`):
```bash
wrangler secret put DATABASE_URL
```
- Ou via le dashboard Cloudflare (Workers > Settings > Variables > Secrets)
- Pour Cloudflare Pages: Settings > Environment variables > Add variable

### Traitement d'images

**Note importante**: Sharp n'est pas disponible dans Cloudflare Workers. Le code actuel stocke les images telles quelles dans R2 sans redimensionnement automatique.

Pour ajouter le redimensionnement d'images, vous avez plusieurs options:

1. **Image Resizing de Cloudflare** (recommandé):
   - Configurez votre bucket R2 avec Image Resizing
   - Utilisez les paramètres de requête pour redimensionner à la volée: `/images/photo.png?width=50&height=50`
   - Voir: https://developers.cloudflare.com/images/image-resizing/

2. **Pré-traiter côté client**:
   - Redimensionnez les images avant l'upload avec une bibliothèque comme `browser-image-compression`

3. **Service externe**:
   - Utilisez un service d'API externe pour le traitement d'images

Pour l'instant, le code stocke les images originales. Vous devrez adapter la fonction `processImage()` selon votre choix.

### CORS

L'API est configurée pour accepter les requêtes depuis `https://myapp.oauth2.croci-monteiro.fr`. 
Modifiez la valeur dans `src/index.js` ou `functions/api/[[path]].js` si nécessaire.

## 🔧 Développement

### Tester localement

```bash
npm run dev
```

Cela lance Wrangler en mode développement avec hot-reload.

### Migrer les données existantes

Si vous avez des données dans l'ancien format (fichiers JSON), vous devrez créer un script de migration personnalisé pour les importer dans PostgreSQL via Prisma.

Exemple de script de migration (à créer selon vos besoins):

```javascript
// scripts/migrate-to-prisma.js
import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function migrate() {
  // Charger les données JSON existantes
  const services = JSON.parse(fs.readFileSync('data/services.json', 'utf8'));
  
  // Importer dans PostgreSQL
  for (const service of services) {
    await prisma.service.create({
      data: {
        name: service.name,
        redirectUrl: service.redirectUrl,
        allowedGroups: service.allowedGroups,
        imagePath: service.imagePath,
        // ... autres champs
      },
    });
  }
}

migrate()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

### Schéma de base de données

Le schéma Prisma définit deux modèles:

- **User**: Stocke les informations des utilisateurs (username, email, displayName, groups)
- **Service**: Stocke les services avec leurs images et groupes autorisés

Voir `prisma/schema.prisma` pour le schéma complet.

