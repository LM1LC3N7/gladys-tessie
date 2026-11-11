# Tessie pour Gladys

Affiche dans Gladys les Tesla de votre compte **Tessie** : niveau de batterie,
autonomie, état et puissance de charge, climatisation, températures intérieure
et extérieure, portes, coffres, fenêtres, verrouillage, mode Sentinelle,
pression des pneus, compteur et état. Une commande : **Verrouiller**.

Jamais testé avec une vraie voiture. Non officiel, sans lien avec Tesla ni avec
Tessie.

## Ce qu'il faut

- Un compte Tessie (service payant, [tessie.com](https://tessie.com)) où se
  trouvent vos voitures.
- Un jeton d'accès : sur [dash.tessie.com](https://dash.tessie.com/settings/api),
  Settings, API, **Generate Access Token**.

## Mise en place

1. Installez l'intégration depuis le store Gladys.
2. Dans sa configuration, collez le jeton dans **Jeton d'accès Tessie**. Il
   est gardé par Gladys dans sa base, jamais réaffiché, et envoyé seulement à
   Tessie (`api.tessie.com`), dans un en-tête.
3. Enregistrez, puis **Tester la connexion** : la réponse donne le nombre de
   voitures renvoyées par Tessie.
4. Dans **Découverte**, créez chaque voiture.

## Ce qui est lu, et à quel rythme

À chaque **intervalle de lecture** (5 minutes par défaut, de 60 s à 1 heure),
Gladys lit le dernier état connu de Tessie pour chaque voiture. Gladys **ne
demande jamais à Tessie de réveiller une voiture** pour la lire : une voiture
endormie garde les valeurs de son dernier réveil.

Chaque groupe de valeurs (charge, climatisation, véhicule, position) porte
l'heure à laquelle Tessie l'a reçu de la voiture :

- moins de 10 minutes : affiché comme une nouvelle valeur (les scènes peuvent
  réagir) ;
- plus ancien : affiché avec sa propre date (les scènes ne réagissent pas) ;
- plus de 2 heures : pas affiché ;
- une valeur déjà affichée n'est pas renvoyée.

Les distances sont en km (Tesla donne des miles : convertis), les températures
en °C, la pression des pneus en bar. Une valeur que la voiture ne donne pas
reste inconnue, jamais 0. Le compteur ne recule jamais.

10 voitures au plus sont suivies (le statut dit combien sont laissées de côté).

## Verrouiller

La fonctionnalité **Verrouillage** d'une voiture est la seule commande. La
passer à verrouillé envoie la commande de verrouillage de Tessie (Tessie
réveille la voiture si besoin). Elle part même quand Tessie a demandé
d'attendre, quand Tessie a refusé le jeton pour les lectures, ou pendant une
lecture. Elle est essayée 3 fois au plus en 3 minutes, et renvoyée après un
redémarrage de l'intégration dans ce délai. Elle se termine quand la voiture
confirme, ou quand une lecture suivante montre la voiture verrouillée. Gladys
relit la voiture 5 s et 20 s après.

Elle ne part pas quand :

- aucun jeton valide n'est encore configuré (elle en attend un 3 minutes au
  plus) ;
- la voiture n'est plus dans le compte Tessie ;
- Tessie refuse la commande (401, 403 ou autre 4xx que 429) : elle n'est pas
  réessayée ;
- les 3 essais sont épuisés, ou les 3 minutes passées.

**Déverrouiller n'est pas disponible** (ni coffres, trappe de charge,
climatisation) : passer la fonctionnalité à déverrouillé est refusé et rien
n'est envoyé.

## La position (désactivée par défaut)

Activez **Afficher la position de la voiture, arrondie** pour obtenir une
fonctionnalité texte avec la latitude et la longitude arrondies à 3 décimales
(environ 100 m), affichée seulement quand la valeur de Tessie a moins de
10 minutes. Désactiver l'option efface la valeur affichée. La navigation
(destination), la vitesse et le cap ne sont jamais lus.

## Le statut

- **Connecté à Tessie : N véhicule(s)** : tout va bien.
- **Tessie a refusé le jeton (401/403)** : les lectures s'arrêtent jusqu'à
  l'enregistrement d'un nouveau jeton ou un test réussi.
- **Tessie a demandé d'attendre (429 ou 5xx)** : les lectures attendent le
  temps indiqué par Tessie (1 minute à 6 heures, gardé après un redémarrage).
- **Tessie n'a pas pu être lu** : réseau ou délai dépassé ; nouvel essai plus
  tard, l'attente doublant jusqu'à 1 heure.
- **La configuration n'a pas pu être lue depuis Gladys** : nouvel essai,
  espacé, sans fin.
- **Le dossier /data est illisible** : les lectures attendent (un arrêt peut y
  être enregistré), nouvel essai toutes les 10 s.

## Vie privée

Le jeton et le VIN ne sont jamais écrits dans les journaux, le statut, ni le
dossier `/data` de l'intégration. Gladys connaît une voiture par un code tiré
de son VIN, jamais par le VIN lui-même.
