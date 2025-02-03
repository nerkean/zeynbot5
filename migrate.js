require('dotenv').config();
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const CommandStats = require('./CommandStats'); 

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('Connected to MongoDB');

    CommandStats.find({ uuid: { $exists: false } })
      .then(users => {
        users.forEach(user => {
          const newUuid = uuidv4(); 
          user.uuid = newUuid; 
          
          user.save()
            .then(() => console.log(`UUID added for user ${user.username}`))
            .catch(err => console.error(`Error saving user ${user.username}:`, err));
        });
      })
      .catch(err => console.error('Error fetching users:', err));
  })
  .catch(err => console.error('Error connecting to MongoDB:', err));
