# Utiliser une image Node.js officielle
FROM node:20-alpine

# Définir le répertoire de travail dans le conteneur
WORKDIR /app

# Copier package.json et package-lock.json (si existe)
COPY package*.json ./

# Installer les dépendances
RUN npm install --production

# Copier tous les fichiers de l'application
COPY . .

# Créer les dossiers nécessaires
RUN mkdir -p /app/uploads /app/data

# Exposer le port de l'application
EXPOSE 3000

# Définir les variables d'environnement par défaut
ENV NODE_ENV=production

# Commande pour démarrer l'application
CMD ["node", "server.js"]
