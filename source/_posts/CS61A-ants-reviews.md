---
title: CS61A-ants reviews
date: 2026-03-29 14:06:46
categories: 
  - CS61A
tags:
  - OOP
---

# 面向对象编程（OOP）

Python是一门[面向对象编程](https://composingprograms.netlify.app/2/5)的语言,与其他OOP语言不同的是Python的特质

----

## Python的特质

Python中，万物都是对象，这意味着类中的任何属性都可被修改，即抽象屏障是极其脆弱的，在维护这一方面，需要遵守Python的接口规则

----

## 多态（Interface）

我更喜欢叫它[接口](https://composingprograms.netlify.app/2/5#_2-5-5-%E7%BB%A7%E6%89%BF)，其指的是[消息传递](https://composingprograms.netlify.app/2/5#_2-5-3-%E6%B6%88%E6%81%AF%E4%BC%A0%E9%80%92%E5%92%8C%E7%82%B9%E8%A1%A8%E8%BE%BE%E5%BC%8F)的不同实现，Python中，子类或实例中可以对父类的同名属性进行复写（override）
当调用子类的属性时，会实现复写的内容而不是父类的，这里就是多态的体现，即一个名字（name）在不同的类中出现，但是我们任然可以去通过这个名字进行组合（Composition）


```Python
class Insect:
    ...
    def action(self, gamestate: GameState):
        """The action performed each turn."""
```

上面的代码中```Insect```作为一个基类，它的属性都应该作为一个接口，即具有多态，拿```action```为例子，虽然这里的```action```什么都没有做，但是这里不能没有```action```，其作为一个接口，为后续的子类提供组合(Composition)的可能

---

## 组合(Composition)

在知道接口是如何使用之后，我们就可以拥有一个强大的方法——**组合(Composition)**


```python
class ContainerAnt(Ant):
    """
    ContainerAnt can share a space with other ants by containing them.
    """
    is_container = True

    def __init__(self, health: int):
        super().__init__(health)
        self.ant_contained = None

    def can_contain(self, other: Ant) -> bool:
        # BEGIN Problem 8a
        "*** YOUR CODE HERE ***"
        if self.ant_contained is None and not other.is_container:
            return True
        return False
        # END Problem 8a

    def store_ant(self, ant: Ant):
        # BEGIN Problem 8a
        "*** YOUR CODE HERE ***"
        self.ant_contained = ant
        # END Problem 8a

    def remove_ant(self, ant: Ant):
        if self.ant_contained is not ant:
            assert False, "{} does not contain {}".format(self, ant)
        self.ant_contained = None

    def remove_from(self, place: Place):
        # Special handling for container ants
        if place.ant is self:
            # Container was removed. Contained ant should remain in the game
            place.ant = self.ant_contained
            Insect.remove_from(self, place)
        else:
            # default to normal behavior
            Ant.remove_from(self, place)

    def action(self, gamestate: GameState):
        # BEGIN Problem 8a
        "*** YOUR CODE HERE ***"
        if not self.ant_contained is None:
            self.ant_contained.action(gamestate)
        # END Problem 8a
```

这里的p8a就深刻体现了组合，当```store_ant```执行的时候，容器蚁（ContainerAnt）就把一个对象封装进了它体内，这里改变了另一个对象中的属性，**即组合可以在一个类中操作另一个类**

```python
class Ant(Insect):
    """An Ant occupies a place and does work for the colony."""

    implemented = False  # Only implemented Ant classes should be instantiated
    food_cost = 0
    is_container = False
    # ADD CLASS ATTRIBUTES HERE
    has_double = False
    # BEGIN Problem 8a
    "*** YOUR CODE HERE ***"
    def can_contain(self,other):
        return False
    # END Problem 8a

    def __init__(self, health: int = 1):
        super().__init__(health)

    def can_contain(self, other: Ant) -> bool:
        return False

    def store_ant(self, ant: Ant):
        assert False, "{0} cannot contain an ant".format(self)

    def remove_ant(self, ant: Ant):
        assert False, "{0} cannot contain an ant".format(self)

    def add_to(self, place: Place):
        if place.ant is None:
            place.ant = self
        else:
            # BEGIN Problem 8b
            if place.ant.can_contain(self):
               place.ant.store_ant(self)
               self.place = place
               return 
            elif self.can_contain(place.ant):
                self.store_ant(place.ant)
                place.ant = self
            else:
                 assert place.ant is None, 'Too many ants in {0}'.format(place)
            # END Problem 8b
        Insect.add_to(self, place)

    def remove_from(self, place: Place):
        if place.ant is self:
            place.ant = None
        elif place.ant is None:
            assert False, '{0} is not in {1}'.format(self, place)
        else:
            place.ant.remove_ant(self)
        Insect.remove_from(self, place)

    def double(self):
        """Double this ants's damage, if it has not already been doubled."""
        # BEGIN Problem 12
        "*** YOUR CODE HERE ***"
        if not self.has_double:
            self.damage *= 2
            self.has_double = True
        # END Problem 12
```
这里我们通过组合，把```Place```的对象修改了，使得一个```Place```上可以有两个甚至多个蚂蚁

----

## 解耦

解耦实际上就是CS61A中提到的对象隐喻，在p12中体现得淋漓精致

```python
class QueenAnt(ThrowerAnt):
    """QueenAnt boosts the damage of all ants behind her."""

    name = 'Queen'
    food_cost = 7
    # OVERRIDE CLASS ATTRIBUTES HERE
    
    # BEGIN Problem 12
    implemented = True   # Change to True to view in the GUI
    # END Problem 12

    def action(self, gamestate: GameState):
        """A queen ant throws a leaf, but also doubles the damage of ants
        in her tunnel.
        """
        # BEGIN Problem 12
        "*** YOUR CODE HERE ***"
        super().action(gamestate)
        current_place = self.place.exit
        while current_place is not None:
            if current_place.ant is not None:
                current_place.ant.double()
                if current_place.ant.is_container and current_place.ant.ant_contained:
                    current_place.ant.ant_contained.double()
            current_place = current_place.exit
        # END Problem 12

    def reduce_health(self, damage_taken: float):
        """Reduce health by DAMAGE_TAKEN, and if the QueenAnt has no health
        remaining, signal the end of the game.
        """
        # BEGIN Problem 12
        "*** YOUR CODE HERE ***"
        super().reduce_health(damage_taken)
        if self.health == 0:
           ants_lose()
        # END Problem 12
```

这里的```QueenAnt```复写了```action```和```reduece_health```方法，在真正实现其复写的内容时，其先调用了```super().'methon'```,这一步就是接口的体现，通过同名的方法，我们可以知道父类实现了什么，从而在子类中可以直接使用

例如这里的```double```，在父类实现其内容后，在子类```QueenAnt```中直接调用，就无需再写重复的代码

## 委托（Delegation）

在```QueenAnt```中，```action```方法体现了**委托（Delgation）**

```python
def action(self, gamestate: GameState):
        """A queen ant throws a leaf, but also doubles the damage of ants
        in her tunnel.
        """
        # BEGIN Problem 12
        "*** YOUR CODE HERE ***"
        super().action(gamestate)
        current_place = self.place.exit
        while current_place is not None:
            if current_place.ant is not None:
                current_place.ant.double()
                if current_place.ant.is_container and current_place.ant.ant_contained:
                    current_place.ant.ant_contained.double()
            current_place = current_place.exit
        # END Problem 12
```

这里```QueenAnt```不需要自己去判断其身后的蚂蚁是否可以受到加成，它只需要把这个判断交给后面的蚂蚁自己去判断，然后拿到结果就可以了

这和p8a的```action```类似
```python
   def action(self, gamestate: GameState):
        # BEGIN Problem 8a
        "*** YOUR CODE HERE ***"
        if not self.ant_contained is None:
            self.ant_contained.action(gamestate)
        # END Problem 8a
```
容器蚁不在乎谁在它里面，它只需要把消息传递到被封装的对象就可以了